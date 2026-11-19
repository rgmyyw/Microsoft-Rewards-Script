import fs from 'node:fs'
import path from 'node:path'

import { getProjectRoot } from '../../scripts/lib/projectFiles.cjs'

/**
 * 运行期账号池控制文件: config/run-pool.json
 * 控制API/面板在批次运行期间写入(移除未执行账号/追加账号), RunCoordinator 在
 * 每个账号开始前读取并应用。文件在每次 /start 时清空, 运行结束后删除。
 */
export interface RunPoolState {
    skipEmails: string[]
    addEmails: string[]
}

function poolFilePath(): string {
    return path.join(getProjectRoot(), 'config', 'run-pool.json')
}

export function readRunPoolState(): RunPoolState {
    try {
        const raw = JSON.parse(fs.readFileSync(poolFilePath(), 'utf8'))
        return {
            skipEmails: Array.isArray(raw?.skipEmails) ? raw.skipEmails.map(String) : [],
            addEmails: Array.isArray(raw?.addEmails) ? raw.addEmails.map(String) : []
        }
    } catch {
        return { skipEmails: [], addEmails: [] }
    }
}

export function clearRunPool(): void {
    try {
        fs.rmSync(poolFilePath(), { force: true })
    } catch {
        // 清理失败不影响运行
    }
}

export function writeRunPoolState(state: RunPoolState): void {
    const file = poolFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
}
