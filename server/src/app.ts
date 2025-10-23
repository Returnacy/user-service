import { buildServer } from './appBuilder.js';

async function main() {
  const server = await buildServer();
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '0.0.0.0';
  await server.listen({ port: PORT, host: HOST });
}

main();
