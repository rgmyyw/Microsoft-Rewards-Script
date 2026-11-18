import { appPromotionType, isAppPromotionComplete } from '../AppPromotion'
import { BaseActivity } from '../../shared/activities/BaseActivity'
import type { AppDashboardData } from '../types/AppDashboardData'

export class AppPromotions extends BaseActivity {
    async run(data: AppDashboardData): Promise<void> {
        const pending = data.response.promotions.filter(promotion => {
            const attributes = promotion.attributes
            return (
                !isAppPromotionComplete(promotion) &&
                Boolean(attributes['offerid']) &&
                appPromotionType(promotion) === 'sapphire'
            )
        })

        if (!pending.length) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'No eligible pending App Promotions are available'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-PROMOTIONS',
            `开始解决"应用推广"项目 | remaining=${pending.length}`
        )
        for (const promotion of pending) {
            await this.bot.activities.runAppReward(promotion)
        }
        this.bot.logger.debug(this.bot.isMobile, 'APP-PROMOTIONS', '"应用推广"项目处理完毕')
    }
}
