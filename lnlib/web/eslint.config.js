import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'src/epub-reader'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TODO: React Compiler rules that arrived with eslint-plugin-react-hooks 7; existing code
      // predates them. Restore to error once the flagged hooks are rewritten.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Japanese UI text uses the ideographic space.
      'no-irregular-whitespace': ['error', { skipTemplates: true, skipJSXText: true }],
    },
  },
  prettier,
);
