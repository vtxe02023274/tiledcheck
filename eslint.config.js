import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Runs inside Tiled as a plain script, `tiledcheck` is its one global.
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { tiled: 'readonly', Process: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^tiledcheck$' }],
    },
  },
);
