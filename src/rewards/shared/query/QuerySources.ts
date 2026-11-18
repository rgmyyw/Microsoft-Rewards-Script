import * as fs from 'node:fs'
import path from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

import { URLs } from '../../../constants/urls'
import { RSS_FEEDS } from '../../../constants/rssFeeds'
import type {
    HackerNewsResponse,
    RedditListing,
    WikipediaRandomResponse,
    WikipediaTopResponse
} from '../search/SearchTypes'
import type { BotContext } from '../../../core/BotContext'
import type { HttpResponse } from '../../../network/HttpClient'
import { localeRequestHeaders } from '../../../network/RequestHeaders'
import { resolveAccountLocale } from '../../../util/Locale'
import { cleanQuery } from './QueryQuality'
import {
    formatQueryOrigin,
    resolveQueryLocale,
    type QueryKind,
    type QueryOrigin,
    type QueryTopic,
    type SourcedQuery
} from './QueryContext'

type QueryContext = Pick<BotContext, 'config' | 'http' | 'isMobile' | 'logger' | 'accountLocale' | 'userData'>

const MAX_RSS_XML_BYTES = 2 * 1024 * 1024
const FEED_CACHE_MS = 5 * 60 * 1000
const XML_DECLARATION_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i

interface RssEntry {
    title?: unknown
    source?: unknown
    pubDate?: unknown
    published?: unknown
    updated?: unknown
}
interface RssDocument {
    rss?: { channel?: { item?: RssEntry | RssEntry[]; language?: unknown } }
    'rdf:RDF'?: { item?: RssEntry | RssEntry[] }
    feed?: { entry?: RssEntry | RssEntry[] }
}
interface RssFeed {
    url: string
    source: string
    kind: QueryKind
    language?: string
    country?: string
}
function toArray(value: RssEntry | RssEntry[] | undefined): RssEntry[] {
    return value ? (Array.isArray(value) ? value : [value]) : []
}
function readText(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    if (value && typeof value === 'object' && '#text' in value) return readText(value['#text'])
    return ''
}

export class QuerySources {
    private readonly feeds = new Map<string, { expires: number; topics: Promise<QueryTopic[]> }>()

    constructor(private readonly bot: QueryContext) {}

    private request<T>(origin: QueryOrigin, language?: string, country?: string): Promise<HttpResponse<T>> {
        const locale = resolveQueryLocale(this.bot)
        const requestLanguage = language ?? origin.language ?? locale.language
        const requestCountry = country ?? origin.country ?? locale.country
        const { acceptLanguage } = resolveAccountLocale({ langCode: requestLanguage, geoLocale: requestCountry })
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-SOURCE',
            `Fetching query source | language=${requestLanguage} | country=${requestCountry} | ${formatQueryOrigin(origin)}`
        )
        return this.bot.http.request<T>(
            {
                url: origin.sourceUrl,
                method: 'GET',
                headers: localeRequestHeaders(acceptLanguage),
                timeout: 8000,
                retries: 0,
                maxResponseBytes: MAX_RSS_XML_BYTES
            },
            this.bot.config.proxy.queryEngine
        )
    }

    getGoogleTrends(country: string, language = 'en'): Promise<QueryTopic[]> {
        return this.getRssTopics(['rss.googleTrends'], language, country)
    }

    async getBingSuggestions(query = '', language = 'en', country = 'US'): Promise<SourcedQuery[]> {
        const origin: QueryOrigin = {
            source: 'bing.suggestions',
            sourceUrl: URLs.queryEngine.bingSuggestions(query, language, country),
            language,
            country
        }
        try {
            const response = await this.request<{
                suggestionGroups?: { searchSuggestions?: { query: string }[] }[]
            }>(origin)
            return (response.data.suggestionGroups?.[0]?.searchSuggestions ?? [])
                .map(item => item.query)
                .filter((text): text is string => typeof text === 'string')
                .map(text => ({ text, ...origin }))
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-BING-SUGGESTIONS', `Request failed | ${String(error)}`)
            return []
        }
    }

    async getBingRelatedTerms(query: string, language = 'en', country = 'US'): Promise<SourcedQuery[]> {
        const origin: QueryOrigin = {
            source: 'bing.related',
            sourceUrl: URLs.queryEngine.bingRelated(query, language, country),
            language,
            country
        }
        try {
            const response = await this.request<unknown[]>(origin)
            const related = response.data?.[1]
            return Array.isArray(related)
                ? related
                      .filter((term): term is string => typeof term === 'string' && term.trim().length > 0)
                      .map(text => ({ text, ...origin }))
                : []
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-BING-RELATED', `Request failed | ${String(error)}`)
            return []
        }
    }

    async getWikipediaTrending(language = 'en'): Promise<QueryTopic[]> {
        const lang = language.split('-')[0] || 'en'
        try {
            const date = new Date(Date.now() - 86400000)
            const origin: QueryOrigin = {
                source: 'wikipedia',
                language: lang,
                sourceUrl: URLs.queryEngine.wikipediaTop(
                    lang,
                    date.getUTCFullYear(),
                    String(date.getUTCMonth() + 1).padStart(2, '0'),
                    String(date.getUTCDate()).padStart(2, '0')
                )
            }
            const response = await this.request<WikipediaTopResponse>(origin)
            return (response.data.items?.[0]?.articles ?? [])
                .filter(
                    article =>
                        !/^(?:Main_Page$|(?:Special|Wikipedia|Help|File|Category|Template|Portal|User|Talk|Draft|Module):)/i.test(
                            article.article
                        )
                )
                .slice(0, 50)
                .map((article, sourceRank) => ({
                    text: article.article.replace(/_/g, ' '),
                    ...origin,
                    kind: 'encyclopedia',
                    publishedAt: date.getTime(),
                    sourceRank
                }))
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-WIKIPEDIA-TRENDING',
                `Request failed | lang=${lang} | ${String(error)}`
            )
            return []
        }
    }

    async getRedditTopics(subreddit = 'popular'): Promise<QueryTopic[]> {
        const safe = subreddit.replace(/[^a-zA-Z0-9_+]/g, '')
        try {
            const origin: QueryOrigin = { source: 'reddit', sourceUrl: URLs.queryEngine.reddit(safe), language: 'en' }
            const response = await this.request<RedditListing>(origin)
            return (response.data.data?.children ?? [])
                .filter(post => !post.data.over_18 && !post.data.stickied)
                .map((post, sourceRank) => ({
                    text: post.data.title,
                    ...origin,
                    kind: 'headline',
                    publishedAt: post.data.created_utc ? post.data.created_utc * 1000 : undefined,
                    sourceRank
                }))
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-REDDIT', `Request failed | ${String(error)}`)
            return []
        }
    }

    async getHackerNewsTopics(): Promise<QueryTopic[]> {
        try {
            const origin: QueryOrigin = { source: 'hackernews', sourceUrl: URLs.queryEngine.hackerNews, language: 'en' }
            const response = await this.request<HackerNewsResponse>(origin)
            return (response.data.hits ?? [])
                .filter(hit => typeof hit.title === 'string')
                .map((hit, sourceRank) => ({
                    text: hit.title!,
                    ...origin,
                    kind: 'headline',
                    publishedAt: hit.created_at_i ? hit.created_at_i * 1000 : undefined,
                    sourceRank
                }))
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'SEARCH-HACKERNEWS', `Request failed | ${String(error)}`)
            return []
        }
    }

    async getWikipediaRandom(language = 'en'): Promise<QueryTopic[]> {
        const lang = language.split('-')[0] || 'en'
        try {
            const origin: QueryOrigin = {
                source: 'wikirandom',
                sourceUrl: URLs.queryEngine.wikipediaRandom(lang),
                language: lang
            }
            const response = await this.request<WikipediaRandomResponse>(origin)
            return (response.data.query?.random ?? []).map((page, sourceRank) => ({
                text: page.title,
                ...origin,
                kind: 'random',
                sourceRank
            }))
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-WIKIPEDIA-RANDOM',
                `Request failed | lang=${lang} | ${String(error)}`
            )
            return []
        }
    }

    async getRssTopics(selectors: string[], language = 'en', country = 'US'): Promise<QueryTopic[]> {
        const feeds = this.resolveRssFeeds(selectors, language, country)
        const lists: QueryTopic[][] = []
        let next = 0
        const deadline = Date.now() + 20000
        await Promise.all(
            Array.from({ length: Math.min(4, feeds.length) }, async () => {
                while (next < feeds.length && Date.now() < deadline) {
                    const index = next++
                    lists[index] = await this.fetchRssTopics(feeds[index]!, language, country)
                }
            })
        )
        return lists.flat()
    }

    private resolveRssFeeds(selectors: string[], language: string, country: string): RssFeed[] {
        const feeds = new Map<string, RssFeed>()
        const add = (site: string, endpoint?: string): void => {
            const entries = RSS_FEEDS[site]
            if (!entries) {
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-RSS', `Unknown RSS site "${site}"`)
                return
            }
            const regional = site === 'googleTrends' || site === 'googleNews'
            const endpoints = endpoint ? [endpoint] : regional ? ['local'] : Object.keys(entries)
            for (const name of endpoints) {
                let url = entries[name]
                let feedCountry: string | undefined
                let feedLanguage: string | undefined = [
                    'googleNews',
                    'bbc',
                    'guardian',
                    'theVerge',
                    'arsTechnica',
                    'reddit'
                ].includes(site)
                    ? 'en'
                    : undefined
                if (regional) {
                    feedCountry = name === 'gb' || name === 'us' ? name.toUpperCase() : country
                    if (site === 'googleTrends' && ['local', 'gb', 'us'].includes(name))
                        url = URLs.queryEngine.googleTrends(feedCountry)
                    if (
                        site === 'googleNews' &&
                        ['local', 'gb', 'us', 'world', 'technology', 'business'].includes(name)
                    ) {
                        feedLanguage = name === 'gb' || name === 'us' ? 'en' : language
                        url = URLs.queryEngine.googleNews(
                            feedLanguage,
                            feedCountry,
                            ['world', 'technology', 'business'].includes(name) ? name : undefined
                        )
                    }
                }
                if (!url) {
                    this.bot.logger.warn(this.bot.isMobile, 'SEARCH-RSS', `Unknown RSS feed "${site}.${name}"`)
                    continue
                }
                feeds.set(url, {
                    url,
                    source: `rss.${site}.${name}`,
                    kind: site === 'googleTrends' ? 'trend' : 'headline',
                    language: feedLanguage,
                    country: feedCountry
                })
            }
        }
        for (const selector of selectors) {
            const [, site, endpoint] = selector.split('.')
            if (site) add(site, endpoint)
            else for (const name of Object.keys(RSS_FEEDS)) add(name)
        }
        return [...feeds.values()]
    }

    private async fetchRssTopics(feed: RssFeed, language: string, country: string): Promise<QueryTopic[]> {
        const origin: QueryOrigin = { ...feed, sourceUrl: feed.url }
        const requestLanguage = feed.language ?? language
        const requestCountry = feed.country ?? country
        const cacheKey = JSON.stringify([feed.url, requestLanguage, requestCountry])
        const cached = this.feeds.get(cacheKey)
        if (cached && cached.expires > Date.now()) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-SOURCE',
                `Using cached feed | language=${requestLanguage} | country=${requestCountry} | ${formatQueryOrigin(origin)}`
            )
            return cached.topics
        }
        const topics = (async (): Promise<QueryTopic[]> => {
            try {
                const response = await this.request<string>(origin, requestLanguage, requestCountry)
                const parsed = typeof response.data === 'string' ? this.parseRssTopics(response.data, feed) : []
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUERY-SOURCE',
                    `Feed ready | topics=${parsed.length} | language=${requestLanguage} | country=${requestCountry} | ${formatQueryOrigin(origin)}`
                )
                return parsed
            } catch (error) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'SEARCH-RSS',
                    `Feed failed | ${formatQueryOrigin(origin)} | ${String(error)}`
                )
                return []
            }
        })()
        const entry = { expires: Date.now() + FEED_CACHE_MS, topics }
        this.feeds.set(cacheKey, entry)
        const result = await topics
        if (!result.length && this.feeds.get(cacheKey) === entry) this.feeds.delete(cacheKey)
        return result
    }

    private parseRssTopics(xml: string, feed: RssFeed): QueryTopic[] {
        if (
            !xml ||
            Buffer.byteLength(xml, 'utf8') > MAX_RSS_XML_BYTES ||
            XML_DECLARATION_RE.test(xml) ||
            XMLValidator.validate(xml) !== true
        )
            return []
        let doc: RssDocument
        try {
            doc = new XMLParser({ ignoreAttributes: true, htmlEntities: true, parseTagValue: false }).parse(xml)
        } catch {
            return []
        }
        const entries = [
            ...toArray(doc.rss?.channel?.item),
            ...toArray(doc['rdf:RDF']?.item),
            ...toArray(doc.feed?.entry)
        ]
        const declaredLanguage = readText(doc.rss?.channel?.language).toLowerCase()
        const language = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(declaredLanguage) ? declaredLanguage : feed.language
        const topics: QueryTopic[] = []
        for (const [sourceRank, entry] of entries.slice(0, 100).entries()) {
            const text = cleanQuery(readText(entry.title), feed.kind === 'headline', readText(entry.source))
            if (!text) continue
            const timestamp = Date.parse(readText(entry.pubDate ?? entry.published ?? entry.updated))
            topics.push({
                text,
                source: feed.source,
                sourceUrl: feed.url,
                kind: feed.kind,
                language,
                country: feed.country,
                publishedAt: Number.isFinite(timestamp) ? timestamp : undefined,
                sourceRank
            })
        }
        return topics
    }

    getLocalQueryList(language = 'en'): QueryTopic[] {
        try {
            const file = path.join(__dirname, '../../../data/search-queries.json')
            const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
            const lang = language.split('-')[0] || 'en'
            const queries: unknown = Array.isArray(data)
                ? lang === 'en'
                    ? data
                    : []
                : data && typeof data === 'object'
                  ? (data as Record<string, unknown>)[lang]
                  : []
            return Array.isArray(queries)
                ? queries
                      .filter((query): query is string => typeof query === 'string')
                      .map((text, sourceRank) => ({
                          text,
                          source: 'local',
                          sourceUrl: 'src/data/search-queries.json',
                          kind: 'evergreen',
                          language: lang,
                          sourceRank
                      }))
                : []
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-LOCAL-QUERY-LIST',
                `Failed reading search-queries.json | ${String(error)}`
            )
            return []
        }
    }

    // ── 中国热搜（V4-china 移植：gmya.net 多源 + 免费档限流退避）──────────────
    // 注: QueryContext 为窄类型(无 utils)，退避/乱序用本文件内的微型实现

    async getChinaTrending(country = 'CN'): Promise<QueryTopic[]> {
        const titles = await this.fetchChinaTrendTitles(country)
        return titles.map((text, sourceRank) => ({
            text,
            source: 'china',
            sourceUrl: 'api.gmya.net',
            kind: 'trend',
            language: 'zh-CN',
            country,
            sourceRank
        }))
    }

    /**
     * 数据源：gmya.net 热门词 API（BaiduHot/TouTiaoHot/DouYinHot/WeiBoHot/ZhiHuHot）。
     *   - appkey 配置在 searchSettings.chinaApi.appkey；留空走免费档。
     * 免费档容易被限流：减少首选源数量以降低触发面，源间随机退避，命中限流后指数退避。
     */
    private async fetchChinaTrendTitles(geoLocale: string): Promise<string[]> {
        const allSources = ['BaiduHot', 'TouTiaoHot', 'DouYinHot', 'WeiBoHot', 'ZhiHuHot']
        const baseUrl = 'https://api.gmya.net/Api/'
        const appkey = this.bot.config.searchSettings.chinaApi?.appkey?.trim() ?? ''
        const hasAppkey = appkey.length > 0
        const pickedCount = hasAppkey ? 2 : 1
        const backoffMin = 1200
        const backoffMax = 2500

        const shuffled = shuffleChinaSources([...allSources])
        const picked = shuffled.slice(0, pickedCount)
        const fallback = shuffled.slice(pickedCount)

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-CHINA-TRENDS',
            `正在获取中国热搜 | 地区=${geoLocale} | appkey=${hasAppkey ? '已配置' : '免费档'} | 首选源=${picked.join(', ')} | 备用源=${fallback.length}个`
        )

        const maybeBackoff = async (multiplier: number): Promise<void> => {
            if (hasAppkey) return
            await sleepMs(randomBetween(backoffMin * multiplier, backoffMax * multiplier))
        }

        const titles = new Set<string>()
        const failedSources: string[] = []
        let backoffMultiplier = 1

        for (let i = 0; i < picked.length; i++) {
            if (i > 0) await maybeBackoff(backoffMultiplier)
            const source = picked[i] as string
            try {
                const result = await this.fetchChinaHotWords(this.buildChinaApiUrl(baseUrl, source, appkey), source)
                if (result.length) {
                    result.forEach(t => titles.add(t))
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'SEARCH-CHINA-TRENDS',
                        `获取 ${source} 成功 | 数量=${result.length} | 累计=${titles.size}`
                    )
                } else {
                    this.bot.logger.warn(this.bot.isMobile, 'SEARCH-CHINA-TRENDS', `${source} 返回空列表`)
                    failedSources.push(source)
                }
            } catch (error) {
                failedSources.push(source)
                if (error instanceof ChinaApiRateLimitError) backoffMultiplier *= 1.5
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SEARCH-CHINA-TRENDS',
                    `${source} 请求失败 | 错误=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        // 如果首选源全部失败，逐个 fallback 直到拿到数据
        if (titles.size === 0 && fallback.length) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'SEARCH-CHINA-TRENDS',
                `首选源全部失败（${failedSources.join(', ')}），尝试备用源 ${fallback.join(', ')}`
            )
            for (const source of fallback) {
                await maybeBackoff(backoffMultiplier)
                try {
                    const result = await this.fetchChinaHotWords(this.buildChinaApiUrl(baseUrl, source, appkey), source)
                    if (result.length) {
                        result.forEach(t => titles.add(t))
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'SEARCH-CHINA-TRENDS',
                            `备用源 ${source} 成功 | 数量=${result.length} | 累计=${titles.size}`
                        )
                        break
                    }
                } catch (error) {
                    if (error instanceof ChinaApiRateLimitError) backoffMultiplier *= 1.5
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SEARCH-CHINA-TRENDS',
                        `备用源 ${source} 请求失败 | 错误=${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-CHINA-TRENDS',
            `中国热搜获取完成 | 标题数=${titles.size} | 失败源=${failedSources.join(', ') || '无'}`
        )
        return [...titles]
    }

    private buildChinaApiUrl(baseUrl: string, source: string, appkey: string): string {
        return appkey ? baseUrl + source + '?format=json&appkey=' + encodeURIComponent(appkey) : baseUrl + source
    }

    /**
     * 请求单个中国热搜源并解析标题。诊断策略：任何异常都把"原始返回值"打到日志里；
     * 唯一例外是限流——上层退避需要它做控制流，用 ChinaApiRateLimitError 单独标记。
     */
    private async fetchChinaHotWords(url: string, source: string): Promise<string[]> {
        let response: HttpResponse<unknown>
        try {
            response = await this.request<unknown>({
                source: 'china.' + source,
                sourceUrl: url,
                language: 'zh-CN',
                country: 'CN'
            })
        } catch (error) {
            const { rateLimited, text } = this.describeChinaFetchError(error)
            if (rateLimited) throw new ChinaApiRateLimitError(source, text)
            throw new Error(source + ' 失败 | 原始响应=' + text)
        }

        if (this.isChinaRateLimited(response)) {
            throw new ChinaApiRateLimitError(source, '原始响应=' + this.summarizeChinaBody(response.data))
        }

        const data = response.data
        // 正常结构：{ data: [{ title: string }, ...] }
        if (data && Array.isArray((data as { data?: unknown }).data)) {
            return ((data as { data: unknown[] }).data as { title?: unknown }[])
                .filter(item => item && typeof item.title === 'string')
                .map(item => item.title as string)
                .filter((title: string) => title.trim().length > 0)
        }
        throw new Error(source + ' 返回结构异常 | 原始响应=' + this.summarizeChinaBody(data))
    }

    private describeChinaFetchError(error: unknown): { rateLimited: boolean; text: string } {
        const status = (error as { status?: number } | null)?.status
        if (status !== undefined) {
            return { rateLimited: status === 403 || status === 429, text: 'HTTP ' + status }
        }
        return {
            rateLimited: false,
            text: '<无响应体> | ' + (error instanceof Error ? error.message : String(error))
        }
    }

    private isChinaRateLimited(response: HttpResponse<unknown>): boolean {
        const status = response.status
        const data = response.data as { code?: unknown; msg?: unknown } | null | undefined
        const code = data?.code
        return (
            status === 403 ||
            status === 429 ||
            code === '403' ||
            code === 403 ||
            code === '429' ||
            code === 429 ||
            (typeof data?.msg === 'string' && data.msg.includes('限'))
        )
    }

    private summarizeChinaBody(body: unknown): string {
        if (body === undefined || body === null || body === '') return '<无响应体>'
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        const replacementCount = (text.match(/\uFFFD/g) ?? []).length
        if (replacementCount > 0 && replacementCount / Math.max(text.length, 1) >= 0.05) {
            const hex = Buffer.from(text, 'utf8').subarray(0, 32).toString('hex')
            return '<非UTF-8响应体 | 长度=' + text.length + ' | 替换符=' + replacementCount + ' | hex前32=' + hex + '>'
        }
        return text.length > 400 ? text.slice(0, 400) + '…' : text
    }
}

/**
 * 中国热搜源限流标记错误。
 * 携带 rateLimited 标记，供 getChinaTrending 做退避决策。
 */
class ChinaApiRateLimitError extends Error {
    rateLimited = true
    constructor(source: string, detail: string) {
        super(source + ' 触发限流：' + detail + '（建议配置 searchSettings.chinaApi.appkey）')
        this.name = 'ChinaApiRateLimitError'
    }
}

function shuffleChinaSources<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[items[i], items[j]] = [items[j]!, items[i]!]
    }
    return items
}

function randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
