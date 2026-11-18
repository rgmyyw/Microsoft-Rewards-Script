import type { Page } from 'patchright'
import type { BotContext } from '../../core/BotContext'
import type { Account } from '../../core/Account'
import { URLs, REWARDS_BASE_URL } from '../../constants/urls'
import { browserTimeout } from '../BrowserTiming'
import { BrowserTaskPage } from '../BrowserTaskPage'
import { configureMediaBlocking } from '../MediaBlocker'
import { saveStorageState } from '../../session/SessionStore'
import { createSessionState } from '../../session/SessionState'
import { LOGIN_SELECTORS } from './LoginStateDetector'

export async function getBingSignInEvidence(page: Page, timeout: number): Promise<string | null> {
    return page
        .waitForFunction(
            profileSelector => {
                const host = location.hostname.toLowerCase()
                if ((host !== 'bing.com' && !host.endsWith('.bing.com')) || host === 'rewards.bing.com') return false
                const model = (
                    window as Window & {
                        _model?: { UserType?: unknown; UserEmail?: unknown; EnforceNotSignedIn?: unknown }
                    }
                )._model
                if (model && ('UserType' in model || 'UserEmail' in model || model.EnforceNotSignedIn === true)) {
                    return model.EnforceNotSignedIn !== true &&
                        typeof model.UserType === 'string' &&
                        model.UserType.trim().toLowerCase() === 'msa' &&
                        typeof model.UserEmail === 'string' &&
                        model.UserEmail.trim()
                        ? 'page-model'
                        : false
                }
                const profile = document.querySelector(profileSelector)
                const name = profile?.textContent?.trim()
                if (!name || /^(?:sign|log)\s*in$/i.test(name)) return false
                const link = profile?.closest<HTMLAnchorElement>('a[href]')
                if (link) {
                    const target = new URL(link.href, location.href)
                    if (
                        target.pathname.toLowerCase() === '/fd/auth/signin' ||
                        target.hostname === 'login.live.com' ||
                        target.hostname === 'login.microsoftonline.com'
                    )
                        return false
                }
                return 'profile-dom'
            },
            LOGIN_SELECTORS.bingProfile,
            { timeout, polling: 250 }
        )
        .then(async handle => {
            try {
                const evidence = await handle.jsonValue()
                return typeof evidence === 'string' ? evidence : null
            } finally {
                await handle.dispose()
            }
        })
        .catch(() => null)
}

export class LoginSession {
    constructor(
        private readonly bot: BotContext,
        private readonly transition: (page: Page, account: Account) => Promise<void>
    ) {}

    async finalize(page: Page, account: Account, sessionOnly = false) {
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '完成登录')

        const browserMode = this.bot.config.rewardsMode === 'browser' && !sessionOnly
        if (browserMode) {
            await page.goto(URLs.rewards.earn, {
                waitUntil: 'domcontentloaded',
                timeout: browserTimeout(this.bot, 'navigation')
            })
        } else {
            await page.goto(REWARDS_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => undefined)
        }

        const rewardsLanding = new URL(page.url())
        const rewardsHostname = rewardsLanding.hostname.toLowerCase()
        const loginRewardsSuccess = rewardsHostname === 'bing.com' || rewardsHostname.endsWith('.bing.com')
        if (loginRewardsSuccess) {
            if (rewardsHostname === 'rewards.bing.com') {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '成功登录Microsoft Rewards')
            } else {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN',
                    `Rewards登录重定向到Bing主页 (${rewardsHostname})；继续验证`
                )
            }
        } else {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN',
                'Could not verify Rewards RewardsDashboard, assuming login valid'
            )
        }

        // Dismiss at rewards dashboard
        await this.bot.browser.utils.dismissMessages(page).catch(() => undefined)

        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '开始Bing会话验证')
        const verification = browserMode ? await BrowserTaskPage.create(page) : undefined
        try {
            const verified = await this.verifyBingSession(verification?.page ?? page, account)
            if (sessionOnly && !verified) throw new Error('Could not verify the signed-in Bing session')
        } finally {
            await verification?.close()
        }

        if (!sessionOnly) {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '获取奖励上下文')
            await this.getRewardsSession(page)
        }

        const context = page.context()
        const storageState = createSessionState(await context.cookies())
        this.bot.signal.throwIfAborted()
        if (sessionOnly && !storageState.cookies.length)
            throw new Error('No session cookies were captured after sign-in')
        this.bot.logger.debug(
            this.bot.isMobile,
            'LOGIN',
            `正在保存会话 | Cookie数=${storageState.cookies.length} | origins=${storageState.origins.length}`
        )
        saveStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile, storageState)

        await configureMediaBlocking(this.bot, context)
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '登录完成，会话已保存')
    }

    async verifyBingSession(page: Page, account: Account): Promise<boolean> {
        const url = URLs.auth.bingSignIn
        const loopMax = 5

        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', '验证Bing会话')

        try {
            await page
                .goto(url, { waitUntil: 'domcontentloaded', timeout: browserTimeout(this.bot, 'navigation') })
                .catch(() => undefined)

            for (let i = 0; i < loopMax; i++) {
                this.bot.signal.throwIfAborted()
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `验证循环 ${i + 1}/${loopMax}`)

                let u = new URL(page.url())
                let hostname = u.hostname.toLowerCase()
                let atBingPage =
                    (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
                if (!atBingPage) {
                    await this.transition(page, account)

                    u = new URL(page.url())
                    hostname = u.hostname.toLowerCase()
                    atBingPage =
                        (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `在Bing页面: ${atBingPage} (${hostname}${u.pathname})`
                )

                if (atBingPage) {
                    await this.bot.browser.utils.dismissMessages(page).catch(() => undefined)

                    const evidence = await getBingSignInEvidence(page, browserTimeout(this.bot, 'optional'))

                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        `Sign-in evidence | source=${evidence || 'none'}`
                    )

                    if (evidence) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN-BING',
                            `Bing session verified successfully | source=${evidence}`
                        )
                        return true
                    }
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', 'Could not verify Bing session')
        } catch (error) {
            this.bot.signal.throwIfAborted()
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `验证错误: ${error instanceof Error ? error.message : String(error)}`
            )
        }
        return false
    }

    private async getRewardsSession(page: Page) {
        this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', '引导奖励上下文')

        try {
            await this.bot.rewards.bootstrap(page)
            if (this.bot.config.rewardsMode === 'browser') return

            const actionsCount = Object.keys(this.bot.nextActions).length
            const snapshot = this.bot.reactSnapshot
            const reportableCount = snapshot?.reportable.length ?? 0
            const availablePoints = snapshot?.account.availablePoints ?? null

            if (!actionsCount) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '未解析到操作ID - 本次运行将跳过服务器操作调用（报告/连击保护）'
                )
            }

            if (!snapshot || !snapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '页面快照为空 - /earn 和 /dashboard 均未渲染出可用的RSC数据'
                )
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `上下文就绪 | actions=${actionsCount} | reportable=${reportableCount} | available=${availablePoints}`
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            this.bot.logger.error(this.bot.isMobile, 'GET-REWARD-SESSION', `获取奖励上下文失败: ${message}`)

            throw new Error(`获取奖励上下文失败: ${message}`)
        }
    }
}
