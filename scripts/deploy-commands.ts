/**
 * Registrazione degli slash command sulla guild.
 *
 * Registrazione per-guild e non globale: la propagazione è immediata,
 * mentre i comandi globali possono richiedere fino a un'ora.
 *
 *   npm run commands:deploy
 */
import { REST, Routes } from 'discord.js';
import { loadEnv, EnvironmentError } from '../src/config/env.js';
import { commandPayloads, commands } from '../src/client/registry.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const payloads = commandPayloads();

  console.log(`Registrazione di ${payloads.length} comandi sulla guild ${env.guildId}…`);
  for (const command of commands) {
    console.log(`  • /${command.name}`);
  }

  const rest = new REST({ version: '10' }).setToken(env.discordToken);

  const result = (await rest.put(Routes.applicationGuildCommands(env.clientId, env.guildId), {
    body: payloads,
  })) as unknown[];

  console.log(`\n✅ ${result.length} comandi registrati.`);
  console.log('Sono già disponibili nel server: la registrazione per-guild è immediata.');
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) {
    console.error(error.message);
  } else {
    console.error('\n❌ Registrazione dei comandi fallita.');
    // Il messaggio dell'errore REST può contenere il token: mai stamparlo
    // per intero.
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
