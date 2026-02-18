"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: 'src',
    testRegex: '.*\\.spec\\.ts$',
    transform: { '^.+\\.ts$': 'ts-jest' },
    collectCoverageFrom: ['**/*.service.ts', '!**/node_modules/**', '!**/dist/**'],
    coverageDirectory: '../coverage',
    testEnvironment: 'node',
};
exports.default = config;
//# sourceMappingURL=jest.config.js.map