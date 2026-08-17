/**
 * Pannelli persistenti su una runtime senza stato.
 *
 * Su Cloudflare non esiste un processo che resta acceso: ogni interaction
 * parte da un isolate potenzialmente nuovo, e un redeploy azzera tutto ciò
 * che non è a database. Il `PersistentPanel` è quindi l'unica memoria che
 * lega un pannello al suo messaggio Discord.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelType } from '../../src/generated/prisma/enums.js';
import { buildVerifyPanel, VERIFY_BUTTON_ID } from '../../src/components/embeds/verifyPanel.js';
import { buildControlPanel } from '../../src/components/embeds/controlPanel.js';
import { parseCustomId } from '../../src/utils/customId.js';
import { componentsByNamespace } from '../../src/interactions/registry.js';
import { createTestAppContext, type TestAppContext } from '../support/appContext.js';

let test: TestAppContext;

beforeEach(() => {
  test = createTestAppContext();
});

describe('pubblicazione', () => {
  it('crea il pannello e ne registra il messaggio a database', async () => {
    const result = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    expect(result.action).toBe('created');
    expect(test.sent).toHaveLength(1);

    const stored = await test.ctx.repos.panels.find(test.ctx.guildId, PanelType.VERIFY);
    expect(stored?.messageId).toBe(result.messageId);
  });

  it('dopo un redeploy aggiorna il messaggio esistente invece di duplicarlo', async () => {
    // Il caso concreto: `/setup verify-panel` rieseguito dopo un deploy.
    // Senza persistenza il canale si riempirebbe di pannelli morti.
    const first = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    const second = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    expect(second.action).toBe('updated');
    expect(second.messageId).toBe(first.messageId);
    expect(test.sent).toHaveLength(1);
    expect(test.edited).toHaveLength(1);
  });

  it('ricrea il pannello se il messaggio è stato cancellato a mano', async () => {
    const first = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    test.deletedMessages.add(first.messageId);

    const second = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    expect(second.action).toBe('created');
    expect(second.messageId).not.toBe(first.messageId);
    expect(test.sent).toHaveLength(2);
  });

  it('verify panel e control panel sono indipendenti', async () => {
    await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });
    await test.ctx.panels.publish({
      panelType: PanelType.CONTROL_PANEL,
      channelId: test.ctx.channels.controlPanel,
      payload: buildControlPanel(await test.ctx.stats.dashboard()),
    });

    expect(test.sent).toHaveLength(2);
    expect(
      await test.ctx.repos.panels.find(test.ctx.guildId, PanelType.CONTROL_PANEL),
    ).not.toBeNull();
  });
});

describe('bottoni sopravvissuti al redeploy', () => {
  it('il customId del pannello resta interpretabile da un processo nuovo', async () => {
    // Il pannello è stato pubblicato "prima": qui simuliamo un isolate
    // completamente nuovo che riceve il click.
    await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });

    const fresh = createTestAppContext();
    const parsed = parseCustomId(VERIFY_BUTTON_ID);

    expect(parsed).toEqual({ namespace: 'verify', action: 'start', args: [] });
    expect(componentsByNamespace.get(parsed?.namespace ?? '')).toBeDefined();
    // Nessuno stato in memoria è necessario per servirlo.
    expect(fresh.ctx.guildId).toBe(test.ctx.guildId);
  });

  it('i customId non incorporano stato volatile, solo identificatori', () => {
    // È la ragione per cui i bottoni sopravvivono a un redeploy: tutto ciò
    // che serve a servire il click sta nel customId o a database.
    const payload = buildControlPanel({
      ttpMembers: 3,
      community: 1,
      active: 3,
      inactive: 0,
      pendingApplications: 2,
      blacklisted: 0,
      permadeath: 0,
      left: 0,
      byRank: { RESIDENT: 1, GANGSTER: 1, YOUNG_OG: 1, BIG: 0, OG: 0 },
    });

    const rows = (payload.components ?? []).map((row) => ('toJSON' in row ? row.toJSON() : row));
    const customIds = rows.flatMap((row) =>
      row.components.map((component) =>
        'custom_id' in component ? component.custom_id : undefined,
      ),
    );

    expect(customIds.length).toBeGreaterThan(0);
    for (const customId of customIds) {
      expect(parseCustomId(customId ?? '')).not.toBeNull();
    }
  });
});

describe('refresh', () => {
  it('non crea nulla se il pannello non è mai stato pubblicato', async () => {
    const result = await test.ctx.panels.refresh({
      panelType: PanelType.VERIFY,
      payload: buildVerifyPanel(),
    });

    expect(result).toBeNull();
    expect(test.sent).toHaveLength(0);
  });

  it('dimentica il pannello sparito, così il prossimo publish lo ricrea', async () => {
    const published = await test.ctx.panels.publish({
      panelType: PanelType.VERIFY,
      channelId: test.ctx.channels.verify,
      payload: buildVerifyPanel(),
    });
    test.deletedMessages.add(published.messageId);

    const result = await test.ctx.panels.refresh({
      panelType: PanelType.VERIFY,
      payload: buildVerifyPanel(),
    });

    expect(result).toBeNull();
    expect(await test.ctx.repos.panels.find(test.ctx.guildId, PanelType.VERIFY)).toBeNull();
  });
});
