import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// 扁平配置（ESLint 9）。该工程此前未接入 lint，故采用「务实基线」：
// 打开明显有价值的规则，关闭对现有 any-heavy 代码噪声过大的规则，避免一次性产生海量报错。
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'build/**',
      'resources/**',
      '*.config.js',
      '*.config.mjs',
      '*.config.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // 代码大量使用 any 作桥接（OpenAI SDK / IPC payload），暂不作硬性约束
      '@typescript-eslint/no-explicit-any': 'off',
      // 空 catch 块为有意的降级容错（已有注释说明），允许
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
      // 「extends 后空接口」等价别名是有意写法，放行
      '@typescript-eslint/no-empty-object-type': 'off',
      // 未使用变量：警告而非报错；允许下划线前缀显式忽略
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      'prefer-const': 'warn'
    }
  },
  // 渲染层：React 规则
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off'
    }
  },
  // 测试文件
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    languageOptions: { globals: globals.node }
  },
  prettier
)
