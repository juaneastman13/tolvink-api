import { AsyncLocalStorage } from 'async_hooks';

export const requestCache = new AsyncLocalStorage<Map<string, any>>();
