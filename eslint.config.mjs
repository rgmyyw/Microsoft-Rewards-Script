import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
    {
        ignores: ['dist/**', 'node_modules/**', 'diagnostics/**', 'sessions/**']
    },

    {
        files: ['**/*.{js,cjs,mjs,ts,cts,mts}'],
        extends: [js.configs.recommended, tseslint.configs.recommended],

        languageOptions: {
            ecmaVersion: 2022,
            globals: {
                ...globals.node
            }
        },

        rules: {
            '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
            'prefer-arrow-callback': 'error',
            'no-empty': 'error',
            'preserve-caught-error': 'off'
        }
    },

    {
        files: ['scripts/main/manualLogin.js'],
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },

    {
        files: ['scripts/**/*.cjs'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off'
        }
    },

    // V4-china 适配: 面板为 CJS 单文件(内嵌浏览器端脚本), 诊断工具为 ESM 脚本,
    // 保留 V4 代码风格(catch(e) 未使用等)
    {
        files: ['dashboard/**', 'scripts/main/**/*.js', 'scripts/tests/**', 'scripts/dev/**'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
        }
    },

    // 面板内嵌浏览器端脚本与 marketProbe/manualLogin 的 page.evaluate 回调使用 DOM 全局
    {
        files: ['dashboard/**', 'scripts/main/marketProbe.js', 'scripts/main/manualLogin.js'],
        languageOptions: {
            globals: { ...globals.browser }
        }
    },

    prettier
)
