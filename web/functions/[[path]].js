// Cloudflare Pages Functions 入口：把请求交给 src/index.js 里同一套路由处理。
// 用 catch-all 是为了让 /api/* 与 /internal/* 都进同一个 handler；
// 静态资源由 _routes.json 排除在外，不需要经过函数（省额度、更快）。
import worker from '../src/index.js'

export const onRequest = (context) => worker.fetch(context.request, context.env)
