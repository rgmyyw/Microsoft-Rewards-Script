import type { BotContext } from '../../../core/BotContext'
import { QueryEngine } from './QueryEngine'
import { queryFingerprint } from './QueryQuality'
import {
    formatQueryOrigin,
    querySourceLocation,
    resolveQueryLocale,
    type QueryTopic,
    type SearchQuery
} from './QueryContext'

export class SearchQueryQueue {
    private topics: QueryTopic[] = []
    private topicIndex = 0
    private activeCluster: SearchQuery[] = []
    private activeMainTopic = ''
    private activeClusterSize = 0
    private activeClusterIndex = 0
    private readonly seenTopics = new Set<string>()
    private readonly seenQueries = new Set<string>()
    private refillCount = 0

    constructor(
        private readonly bot: BotContext,
        private readonly queryCore = new QueryEngine(bot)
    ) {}

    async prepare(): Promise<number> {
        if (!this.topics.length) await this.refillTopics()
        const locale = resolveQueryLocale(this.bot)
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-QUEUE',
            `队列已准备 | 主题数=${this.topics.length} | 聚类搜索=${this.bot.config.searchSettings.clusterSearch}` +
                ` | localeMode=${locale.mode} | language=${locale.language} | country=${locale.country} | engines=${this.bot.config.searchSettings.queryEngines.join(',')}`
        )
        return this.topics.length
    }

    async next(): Promise<SearchQuery | null> {
        while (!this.activeCluster.length) {
            if (this.activeMainTopic) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUERY-QUEUE',
                    `聚类已用尽 | 主题="${this.activeMainTopic}" | 已发出=${this.activeClusterIndex}/${this.activeClusterSize}`
                )
            }

            const mainTopic = await this.nextMainTopic()
            if (!mainTopic) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUERY-QUEUE',
                    `队列已耗尽 | 已见主题=${this.seenTopics.size} | 已见查询=${this.seenQueries.size}`
                )
                return null
            }

            const cluster = await this.queryCore.getCluster(mainTopic)
            let skippedSeen = 0
            this.activeCluster = cluster.filter(query => {
                const key = queryFingerprint(query.text)
                if (!key || this.seenQueries.has(key)) {
                    skippedSeen++
                    return false
                }
                this.seenQueries.add(key)
                return true
            })
            this.activeMainTopic = mainTopic.text
            this.activeClusterSize = this.activeCluster.length
            this.activeClusterIndex = 0

            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-QUEUE',
                `Cluster activated | main=${JSON.stringify(mainTopic.text)} | ${formatQueryOrigin(mainTopic)} | topic=${this.topicIndex}/${this.topics.length} | received=${cluster.length} | queued=${this.activeCluster.length} | skippedSeen=${skippedSeen}`
            )
        }

        const query = this.activeCluster.shift() ?? null
        if (!query) return null

        this.activeClusterIndex++
        this.bot.logger.debug(
            this.bot.isMobile,
            'SEARCH-QUERY',
            `Query selected | query=${JSON.stringify(query.text)} | localeMode=${query.locale.mode} | language=${query.locale.language} | country=${query.locale.country}` +
                ` | ${formatQueryOrigin(query)} | cluster=${this.activeClusterIndex}/${this.activeClusterSize}` +
                (query.source !== query.topic.source
                    ? ` | topic=${JSON.stringify(query.topic.text)} | topicSource=${query.topic.source} | topicFetchedFrom=${JSON.stringify(querySourceLocation(query.topic.sourceUrl))}`
                    : '')
        )
        return query
    }

    private async nextMainTopic(): Promise<QueryTopic | null> {
        while (this.topicIndex >= this.topics.length) {
            if ((await this.refillTopics()) === 0) return null
        }

        const topic = this.topics[this.topicIndex++]
        if (!topic) return null

        this.seenTopics.add(queryFingerprint(topic.text))
        return topic
    }

    private async refillTopics(): Promise<number> {
        const topics = await this.queryCore.getTopics(this.refillCount > 0)
        this.refillCount++
        this.topics = topics.filter(topic => {
            const key = queryFingerprint(topic.text)
            return key.length > 0 && !this.seenTopics.has(key) && !this.seenQueries.has(key)
        })
        this.topicIndex = 0
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-QUEUE',
            `主题池已补充 | 接收=${topics.length} | 入队=${this.topics.length} | 此前已见=${this.seenTopics.size}`
        )
        return this.topics.length
    }
}
