import { type ActivityResult } from '../../shared/ActivityResult'
import { activationOutcome, activationActivity, activationException } from '../../shared/ActivationOutcome'
import type { RewardsState } from '../../types/RewardsState'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import { detectSearchMultiplierPerk } from '../../shared/SearchMultiplierPerk'

export class ActivateSearchPerk extends BaseActivity {
    async activate(data: RewardsState): Promise<ActivityResult> {
        const perk = detectSearchMultiplierPerk(data.dashboard)
        if (!perk) {
            this.bot.logger.debug(this.bot.isMobile, 'ACTIVATE-SEARCH-PERK', 'dashboard 上没有搜索倍数加成')
            return activationActivity(activationOutcome('unavailable', 'perk-unavailable'))
        }

        let live
        try {
            live = await this.bot.rewards.resolveOffer(perk.offerId)
        } catch (error) {
            return activationActivity(activationException(error, perk.offerId))
        }
        if (!live) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVATE-SEARCH-PERK',
                `dashboard 上存在 ${perk.multiplier}x 搜索加成但页面快照中缺失 - 无法激活 | offerId=${perk.offerId}`
            )
            return activationActivity(activationOutcome('unconfirmed', 'activation-data-unavailable', perk.offerId))
        }

        if (live.isCompleted)
            return activationActivity(activationOutcome('already-active', 'already-active', perk.offerId))
        if (live.isLocked) return activationActivity(activationOutcome('unavailable', 'offer-locked', perk.offerId))
        if (live.date && Date.parse(live.date) > Date.now())
            return activationActivity(activationOutcome('unavailable', 'offer-not-yet-available', perk.offerId))

        if (!live.reportable) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'ACTIVATE-SEARCH-PERK',
                `${perk.multiplier}x search perk is present but activation metadata is incomplete | offerId=${perk.offerId}`
            )
            return activationActivity(activationOutcome('unconfirmed', 'activation-metadata-missing', perk.offerId))
        }

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVATE-SEARCH-PERK',
                '跳过：bundle 中未发现 "reportActivity" action id'
            )
            return activationActivity(activationOutcome('unconfirmed', 'activation-metadata-missing', perk.offerId))
        }

        const activityType = live.activityType ?? 11

        this.bot.logger.debug(
            this.bot.isMobile,
            'ACTIVATE-SEARCH-PERK',
            `正在激活 ${perk.multiplier}x 搜索加成 | offerId=${perk.offerId} | geo=${this.bot.userData.geoLocale}`
        )

        try {
            const { status, acknowledged } = await this.bot.rewards.reportServerAction(actionId, [
                live.hash,
                activityType,
                {
                    offerid: perk.offerId,
                    isPromotional: 'true',
                    timezoneOffset: this.bot.userData.timezoneOffset
                }
            ])

            if (status < 200 || status >= 300)
                return activationActivity(
                    activationOutcome(
                        status >= 400 && status < 500 ? 'failed' : 'unconfirmed',
                        status >= 400 && status < 500 ? 'activation-request-rejected' : 'activation-request-error',
                        perk.offerId,
                        true,
                        { httpStatus: status, acknowledged }
                    )
                )

            this.bot.logger.debug(
                this.bot.isMobile,
                'ACTIVATE-SEARCH-PERK',
                `响应 | offerId=${perk.offerId} | status=${status} | acknowledged=${acknowledged}`
            )

            if (acknowledged) {
                this.bot.logger.success(
                    this.bot.isMobile,
                    'ACTIVATE-SEARCH-PERK',
                    `已激活 ${perk.multiplier}x 搜索加成 | offerId=${perk.offerId} | 每日搜索积分上限已提升`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'ACTIVATE-SEARCH-PERK',
                    `激活未被确认 | offerId=${perk.offerId} | status=${status}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
            return activationActivity(
                activationOutcome(
                    acknowledged ? 'activated' : 'unconfirmed',
                    acknowledged ? 'activation-acknowledged' : 'activation-not-confirmed',
                    perk.offerId,
                    true,
                    { httpStatus: status, acknowledged, verified: false }
                )
            )
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'ACTIVATE-SEARCH-PERK',
                `激活搜索加成出错 | offerId=${perk.offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            return activationActivity(activationException(error, perk.offerId, true))
        }
    }
}
