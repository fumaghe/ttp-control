/**
 * PUT ON / PUT OFF — annunci pubblici dei cambi di rank.
 *
 * Due cose vanno dimostrate qui, e sono indipendenti:
 *
 *  1. QUANDO si annuncia. L'annuncio è agganciato alla mutazione di rank, non
 *     al comando: promote, demote e cambio rank diretto passano tutti dallo
 *     stesso punto, quindi producono lo stesso annuncio. Un ingresso nella
 *     gang, invece, non è un Put On.
 *  2. CHE l'annuncio non è autorevole. Se il canale non risponde, il cambio di
 *     rank resta valido: è la parte che distingue una decorazione da un
 *     effetto collaterale pericoloso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIEmbed } from 'discord-api-types/v10';
import { MemberRank } from '../../src/generated/prisma/enums.js';
import { RANK_LABEL } from '../../src/config/constants.js';
import { ERROR_CODE } from '../../src/errors/AppError.js';
import { buildRankAnnouncement } from '../../src/components/embeds/rankAnnouncement.js';
import { directionOf } from '../../src/services/rankAnnouncementService.js';
import {
  addFakeMember,
  CHANNEL_IDS,
  createHarness,
  ROLE_IDS,
  verifyUser,
  type Harness,
  type SentMessage,
} from '../support/harness.js';

const USER = '900000000000000001';
const OG = '900000000000000010';

let h: Harness;

async function joined(rank: MemberRank = MemberRank.RESIDENT): Promise<void> {
  addFakeMember(h.guild, USER, { position: 1 });
  await verifyUser(h, USER);
  await h.members.addToGang({ discordId: USER, actorDiscordId: OG, rank, source: 'manual' });
}

/** Gli annunci pubblicati sul canale Put On / Put Off. */
function announcements(): SentMessage[] {
  return h.guild.messages.filter((m) => m.channelId === CHANNEL_IDS.putOnOff);
}

/** Il primo embed di un messaggio, già serializzato. */
function embedOf(message: SentMessage): APIEmbed {
  const embed = message.payload.embeds?.[0];
  if (!embed) throw new Error('messaggio senza embed');
  return 'toJSON' in embed ? embed.toJSON() : embed;
}

function onlyAnnouncement(): APIEmbed {
  const all = announcements();
  expect(all).toHaveLength(1);
  const first = all[0];
  if (!first) throw new Error('nessun annuncio');
  return embedOf(first);
}

beforeEach(() => {
  h = createHarness();
  addFakeMember(h.guild, OG, { roles: [ROLE_IDS.ttp, ROLE_IDS.og], position: 90 });
});

describe('direzione del cambio di rank', () => {
  it('sale = PUT ON, scende = PUT OFF, uguale = nessun annuncio', () => {
    expect(directionOf(MemberRank.RESIDENT, MemberRank.GANG_BANGER)).toBe('PUT_ON');
    expect(directionOf(MemberRank.BIG_HOMIE, MemberRank.OG)).toBe('PUT_ON');
    expect(directionOf(MemberRank.OG, MemberRank.BIG_HOMIE)).toBe('PUT_OFF');
    expect(directionOf(MemberRank.LOC, MemberRank.TINY_LOC)).toBe('PUT_OFF');
    expect(directionOf(MemberRank.BIG, MemberRank.BIG)).toBeNull();
  });

  it('usa la gerarchia, non l’ordine alfabetico', () => {
    // Alfabeticamente 'BIG' < 'BIG_HOMIE' ma anche 'LOC' < 'TINY_LOC', che
    // nella gerarchia è il contrario: un confronto fra stringhe scambierebbe
    // Put On e Put Off proprio su questa coppia.
    expect(directionOf(MemberRank.TINY_LOC, MemberRank.LOC)).toBe('PUT_ON');
    expect(directionOf(MemberRank.LOC, MemberRank.TINY_LOC)).toBe('PUT_OFF');
  });

  it('riconosce un salto di più livelli come un unico Put On', () => {
    expect(directionOf(MemberRank.RESIDENT, MemberRank.OG)).toBe('PUT_ON');
  });
});

describe('/member promote', () => {
  it('pubblica UN Put On sul canale corretto', async () => {
    await joined(MemberRank.RESIDENT);
    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito sul campo' });

    const all = announcements();
    expect(all).toHaveLength(1);

    const [first] = all;
    if (!first) throw new Error('nessun annuncio pubblicato');
    expect(first.channelId).toBe(CHANNEL_IDS.putOnOff);

    const embed = embedOf(first);
    expect(embed.title).toContain('PUT ON');
    expect(embed.description).toContain(`<@${USER}>`);
    expect(embed.description).toContain(RANK_LABEL[MemberRank.RESIDENT]);
    expect(embed.description).toContain(RANK_LABEL[MemberRank.GANG_BANGER]);
  });

  it('attribuisce la promozione all’attore e riporta il motivo', async () => {
    await joined(MemberRank.RESIDENT);
    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito sul campo' });

    const embed = onlyAnnouncement();
    const fields = embed.fields ?? [];
    expect(fields.some((f) => f.value.includes(OG))).toBe(true);
    expect(fields.some((f) => f.value.includes('Merito sul campo'))).toBe(true);
  });
});

describe('/member demote', () => {
  it('pubblica UN Put Off', async () => {
    await joined(MemberRank.LOC);
    await h.members.demote({ discordId: USER, actorDiscordId: OG, reason: 'Inattività' });

    const embed = onlyAnnouncement();
    expect(embed.title).toContain('PUT OFF');
    expect(embed.description).toContain(RANK_LABEL[MemberRank.LOC]);
    expect(embed.description).toContain(RANK_LABEL[MemberRank.TINY_LOC]);
  });
});

describe('/member rank — cambio diretto', () => {
  it('verso l’alto produce un Put On', async () => {
    await joined(MemberRank.TINY_LOC);
    await h.members.setRank({
      discordId: USER,
      actorDiscordId: OG,
      rank: MemberRank.BIG_HOMIE,
      reason: 'Nomina straordinaria',
    });

    const embed = onlyAnnouncement();
    expect(embed.title).toContain('PUT ON');
  });

  it('verso il basso produce un Put Off', async () => {
    await joined(MemberRank.BIG_HOMIE);
    await h.members.setRank({
      discordId: USER,
      actorDiscordId: OG,
      rank: MemberRank.GANG_BANGER,
      reason: 'Ristrutturazione',
    });

    const embed = onlyAnnouncement();
    expect(embed.title).toContain('PUT OFF');
  });

  it('sullo stesso rank non annuncia nulla: l’operazione è già un errore', async () => {
    await joined(MemberRank.LOC);
    await expect(
      h.members.setRank({
        discordId: USER,
        actorDiscordId: OG,
        rank: MemberRank.LOC,
        reason: 'Nessun cambiamento',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.RANK_UNCHANGED });

    expect(announcements()).toHaveLength(0);
  });
});

describe('quello che NON è un Put On', () => {
  it('l’ingresso nella gang a Resident non produce annunci', async () => {
    await joined(MemberRank.RESIDENT);
    expect(announcements()).toHaveLength(0);
  });

  it('nemmeno un ingresso diretto a un rank alto è un Put On', async () => {
    // `/member add` con rank esplicito resta un ingresso, non una promozione:
    // il membro non stava da nessuna parte, quindi non è stato "messo su".
    await joined(MemberRank.BIG_HOMIE);
    expect(announcements()).toHaveLength(0);
  });

  it('l’approvazione di una candidatura non produce un Put On', async () => {
    addFakeMember(h.guild, USER, { position: 1 });
    await verifyUser(h, USER);
    const application = await h.applications.create({
      discordId: USER,
      username: 'tony',
      displayName: 'Tony',
    });
    await h.applications.approve({ applicationId: application.id, actorDiscordId: OG });

    expect((await h.members.find(USER))?.rank).toBe(MemberRank.RESIDENT);
    expect(announcements()).toHaveLength(0);
  });

  it('inactive, active e uscita dalla gang non producono annunci', async () => {
    await joined(MemberRank.LOC);
    await h.members.setInactive({ discordId: USER, actorDiscordId: OG });
    await h.members.setActive({ discordId: USER, actorDiscordId: OG });
    await h.members.removeFromGang({ discordId: USER, actorDiscordId: OG, reason: 'Uscita' });

    expect(announcements()).toHaveLength(0);
  });
});

describe('l’annuncio non è autorevole', () => {
  it('se il canale non risponde, la promozione resta valida', async () => {
    await joined(MemberRank.RESIDENT);
    h.guild.failMessages = true;

    // Non deve lanciare: l'interaction dell'operatore non può fallire per un
    // messaggio non recapitato.
    const outcome = await h.members.promote({
      discordId: USER,
      actorDiscordId: OG,
      reason: 'Merito',
    });

    expect(outcome.toRank).toBe(MemberRank.GANG_BANGER);
    expect((await h.members.find(USER))?.rank).toBe(MemberRank.GANG_BANGER);
    expect(h.guild.members.get(USER)?.roles.has(ROLE_IDS.gangBanger)).toBe(true);
    expect(announcements()).toHaveLength(0);
  });

  it('un annuncio fallito non corrompe Member.version', async () => {
    await joined(MemberRank.RESIDENT);
    const before = await h.members.find(USER);
    h.guild.failMessages = true;

    await h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' });

    const after = await h.members.find(USER);
    // Esattamente una mutazione: nessun rollback, nessuna riapplicazione.
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it('se il rank non cambia per un errore, non parte nessun annuncio', async () => {
    await joined(MemberRank.OG);
    await expect(
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' }),
    ).rejects.toMatchObject({ code: ERROR_CODE.RANK_AT_MAXIMUM });

    expect(announcements()).toHaveLength(0);
  });

  it('un fallimento Discord sui ruoli annulla tutto, annuncio compreso', async () => {
    await joined(MemberRank.RESIDENT);
    h.gateway.options.failRoleUpdates = true;

    await expect(
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'Merito' }),
    ).rejects.toThrow();

    // La compensazione ha riportato il rank indietro: annunciare un Put On
    // che non è avvenuto sarebbe peggio che non annunciare nulla.
    expect((await h.members.find(USER))?.rank).toBe(MemberRank.RESIDENT);
    expect(announcements()).toHaveLength(0);
  });
});

describe('promote concorrenti', () => {
  it('due promote simultanei producono UN solo annuncio', async () => {
    await joined(MemberRank.TINY_LOC);

    await Promise.allSettled([
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'A' }),
      h.members.promote({ discordId: USER, actorDiscordId: OG, reason: 'B' }),
    ]);

    // Una sola mutazione valida ⇒ un solo Put On. Il secondo promote viene
    // rifiutato dal locking ottimistico e non arriva mai all'annuncio.
    expect((await h.members.find(USER))?.rank).toBe(MemberRank.LOC);
    const embed = onlyAnnouncement();
    expect(embed.title).toContain('PUT ON');
  });
});

describe('embed Put On / Put Off', () => {
  it('il Put On mostra la scaletta da → a e il brand della gang', () => {
    const payload = buildRankAnnouncement({
      memberDiscordId: USER,
      actorDiscordId: OG,
      fromRank: MemberRank.RESIDENT,
      toRank: MemberRank.GANG_BANGER,
      direction: 'PUT_ON',
      reason: 'Merito',
    });

    const raw = payload.embeds?.[0];
    if (!raw) throw new Error('embed mancante');
    const embed = 'toJSON' in raw ? raw.toJSON() : raw;

    expect(embed.title).toBe('🔥 PUT ON');
    expect(embed.description).toContain('messo su');
    expect(embed.description).toContain('↓');
    expect(embed.footer?.text).toBe('TTP — Impero');
    expect(embed.fields?.[0]?.name).toBe('Promosso da');
  });

  it('il Put Off usa un tono e un colore diversi', () => {
    const putOn = buildRankAnnouncement({
      memberDiscordId: USER,
      actorDiscordId: OG,
      fromRank: MemberRank.LOC,
      toRank: MemberRank.ORIGINAL_TINY_LOC,
      direction: 'PUT_ON',
    });
    const putOff = buildRankAnnouncement({
      memberDiscordId: USER,
      actorDiscordId: OG,
      fromRank: MemberRank.LOC,
      toRank: MemberRank.TINY_LOC,
      direction: 'PUT_OFF',
    });

    const on = putOn.embeds?.[0];
    const off = putOff.embeds?.[0];
    if (!on || !off) throw new Error('embed mancante');
    const onJson = 'toJSON' in on ? on.toJSON() : on;
    const offJson = 'toJSON' in off ? off.toJSON() : off;

    expect(offJson.title).toBe('📉 PUT OFF');
    expect(offJson.description).toContain('messo giù');
    expect(offJson.fields?.[0]?.name).toBe('Gestito da');
    expect(offJson.color).not.toBe(onJson.color);
  });

  it('neutralizza il markdown nel motivo scritto dall’operatore', () => {
    const payload = buildRankAnnouncement({
      memberDiscordId: USER,
      actorDiscordId: OG,
      fromRank: MemberRank.RESIDENT,
      toRank: MemberRank.GANG_BANGER,
      direction: 'PUT_ON',
      reason: '**finto grassetto** e `codice`',
    });

    const raw = payload.embeds?.[0];
    if (!raw) throw new Error('embed mancante');
    const embed = 'toJSON' in raw ? raw.toJSON() : raw;
    const reason = embed.fields?.find((f) => f.name === 'Motivo')?.value ?? '';

    expect(reason).toContain('\\*');
    expect(reason).not.toContain('**finto');
  });

  it('funziona anche senza motivo', () => {
    const payload = buildRankAnnouncement({
      memberDiscordId: USER,
      actorDiscordId: OG,
      fromRank: MemberRank.BIG,
      toRank: MemberRank.BIG_HOMIE,
      direction: 'PUT_ON',
    });

    const raw = payload.embeds?.[0];
    if (!raw) throw new Error('embed mancante');
    const embed = 'toJSON' in raw ? raw.toJSON() : raw;

    expect(embed.fields?.some((f) => f.name === 'Motivo')).toBe(false);
  });
});
