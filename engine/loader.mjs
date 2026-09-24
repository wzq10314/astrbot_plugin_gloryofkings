// Resolve Yunzai-provided packages from this bridge, without changing upstream files.
const here = new URL('./worker.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'puppeteer') specifier = 'puppeteer-core';
  try { return await next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || /^[.#/]|^[a-z]+:/i.test(specifier)) throw error;
    return next(specifier, {...context, parentURL: here});
  }
}
