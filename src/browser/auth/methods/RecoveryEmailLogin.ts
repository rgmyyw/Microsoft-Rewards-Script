import { ghostClick } from '../../GhostClick'
import { browserTimeout } from '../../BrowserTiming'
import type { Page } from 'patchright'
import type { LoginContext } from '../LoginContext'
import { canPromptForInput, getErrorMessage, promptInput, waitForInputResponse } from './LoginUtils'

export class RecoveryLogin {
    private readonly textInputSelector =
        'input#proof-confirmation-email-input, input[data-testid="proof-confirmation"], [data-testid="proof-confirmation"] input'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: LoginContext) {}

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '填写恢复邮箱')

            this.bot.signal.throwIfAborted()
            const timeout = browserTimeout(this.bot)
            const input = page.locator(`:is(${this.textInputSelector}):visible`).first()
            await input.waitFor({ state: 'visible', timeout })
            await ghostClick(page, input, timeout, this.bot.signal)
            await input.fill(email, { timeout })
            await input.press('Enter', { timeout })
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'Recovery email submitted; waiting for response')
            return true
        } catch (error) {
            this.bot.signal.throwIfAborted()
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `填写邮箱输入失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page, recoveryEmail: string): Promise<void> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '邮箱恢复身份验证流程已启动')

            if (recoveryEmail) {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '使用配置的恢复邮箱')

                const filled = await this.fillEmail(page, recoveryEmail)
                if (!filled) {
                    throw new Error('Email input field not found')
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '等待页面响应')
                await waitForInputResponse(page, this.textInputSelector, browserTimeout(this.bot))

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    throw new Error(`Email verification failed: ${errorMessage}`)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    'Recovery email response received; checking next sign-in state'
                )
                return
            }

            if (!canPromptForInput()) {
                throw new Error('Recovery email is required because interactive stdin is unavailable')
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', '未提供恢复邮箱，将提示用户输入')

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `开始尝试 ${attempt}/${this.maxManualAttempts}`
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `提示用户输入邮箱 (超时: ${this.maxManualSeconds}秒)`
                )

                const email = await promptInput({
                    question: `Recovery email (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                })

                if (!email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `未收到或收到无效邮箱输入 (尝试 ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: no input received')
                    }
                    continue
                }

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `收到无效邮箱格式 (尝试 ${attempt}/${this.maxManualAttempts}) | 长度=${email.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: invalid format')
                    }
                    continue
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '从用户收到有效邮箱')

                const filled = await this.fillEmail(page, email)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `无法填写邮箱输入字段 (尝试 ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Email input field not found after maximum attempts')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', '等待页面响应')
                await waitForInputResponse(page, this.textInputSelector, browserTimeout(this.bot))

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `页面错误: "${errorMessage}" (尝试 ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached. Last error: ${errorMessage}`)
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    'Recovery email response received; checking next sign-in state'
                )
                return
            }

            throw new Error(`Email input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'LOGIN-RECOVERY', `致命错误: ${errorMsg}`)
            throw error
        }
    }
}
