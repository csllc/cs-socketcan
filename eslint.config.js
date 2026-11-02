'use strict';

// ESLint flat config (ESLint 9+). Replaces the old .eslintrc.js.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
];
