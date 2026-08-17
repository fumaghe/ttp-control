/**
 * Costruzione del Discord client.
 *
 * Intents al minimo indispensabile:
 *   - `Guilds`        — ciclo di vita di canali e ruoli
 *   - `GuildMembers`  — privileged, serve per leggere i ruoli dei membri
 *
 * `MessageContent` NON è abilitato: il bot non legge i messaggi degli utenti
 * e non ha alcun motivo per farlo.
 */
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    // `GuildMember` parziale: `guildMemberRemove` arriva spesso senza dati
    // completi, e senza questo l'evento verrebbe semplicemente perso.
    partials: [Partials.GuildMember, Partials.User],

    // Cache limitata a ciò che serve davvero: i membri servono per i ruoli,
    // i messaggi no.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      GuildMemberManager: Infinity,
    }),

    allowedMentions: {
      // Le menzioni negli embed devono restare cliccabili ma non pingare:
      // un log di audit non deve svegliare mezzo server.
      parse: [],
      repliedUser: false,
    },
  });
}
