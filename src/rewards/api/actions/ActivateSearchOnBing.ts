import type { BotContext } from '../../../core/BotContext'
import type { BasePromotion } from '../../types/RewardsState'
import { isTerminalHttpError } from '../../../network/HttpError'

export async function activateSearchOnBing(bot: BotContext, promotion: BasePromotion): Promise<boolean> {
    const offerId = promotion.offerId
    const actionId = bot.nextActions.reportActivity

    if (!actionId) {
        bot.logger.warn(bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `跳过 ${offerId}：bundle 中未发现 "reportActivity"`)
        return false
    }

    const live = await bot.rewards.resolveOffer(offerId)
    const hash = live?.hash ?? promotion.hash ?? null
    if (!hash) {
        bot.logger.warn(bot.isMobile, 'SEARCH-ON-BING-ACTIVATE', `跳过 ${offerId}: 激活活动无可用 hash`)
        return false
    }

    try {
        const { status, acknowledged } = await bot.rewards.reportServerAction(actionId, [
            hash,
            11,
            {
                offerid: offerId,
                isPromotional: '$undefined',
                timezoneOffset: bot.userData.timezoneOffset
            }
        ])

        bot.logger.debug(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `活动已激活 | offerId=${offerId} | 状态=${status} | 已确认=${acknowledged}`
        )
        return acknowledged
    } catch (error) {
        bot.signal.throwIfAborted()
        if (isTerminalHttpError(error)) throw error
        bot.logger.error(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `激活失败 | offerId=${offerId} | 错误=${error instanceof Error ? error.message : String(error)}`
        )
        return false
    }
}
