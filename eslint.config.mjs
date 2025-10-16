import apifyTypeScriptConfig from '@apify/eslint-config/ts.js';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist', '**/.venv', 'evals/**'] }, // Ignores need to happen first
    ...apifyTypeScriptConfig,
    {
        languageOptions: {
            sourceType: 'module',

            parserOptions: {
                project: 'tsconfig.eslint.json',
            },
        },
    },
];
