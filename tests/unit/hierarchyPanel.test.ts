import { describe, expect, it } from 'vitest';
import { PanelType } from '../../src/generated/prisma/enums.js';
import { buildHierarchyPanel } from '../../src/components/embeds/hierarchyPanel.js';
import { toApiMessage } from '../../src/discord/payload.js';
import type { GuildMemberSnapshotRow } from '../../src/repositories/types.js';
import { createTestAppContext } from '../support/appContext.js';
import { CHANNEL_IDS } from '../support/harness.js';

function snapshot(input: {
  discordId: string;
  roleIds: readonly string[];
  nickname?: string;
  inGuild?: boolean;
}): GuildMemberSnapshotRow {
  return {
    discordId: input.discordId,
    inGuild: input.inGuild ?? true,
    roleIds: input.roleIds,
    rolesHash: input.roleIds.join(','),
    nickname: input.nickname ?? null,
  };
}

describe('pannello gerarchia', () => {
  it('usa tag reali dei ruoli nel contenuto normale e non mostra la descrizione', () => {
    const test = createTestAppContext();
    const payload = buildHierarchyPanel(
      [
        snapshot({
          discordId: '400000000000000001',
          nickname: 'Boss',
          roleIds: [test.ctx.roles.rank.OG],
        }),
        snapshot({
          discordId: '400000000000000002',
          nickname: 'Recluta',
          roleIds: [test.ctx.roles.rank.GANG_BANGER],
        }),
      ],
      test.ctx.roles,
    );

    expect(payload.embeds).toBeUndefined();
    expect(payload.content).toContain('## 🏛️ GERARCHIA GRAPE');
    expect(payload.content).not.toContain('Membri raggruppati per ruolo gerarchico');
    expect(payload.content).toContain(`**<@&${test.ctx.roles.rank.OG}> · 1**`);
    expect(payload.content).toContain('• <@400000000000000001>');
    expect(payload.content).toContain(`**<@&${test.ctx.roles.rank.BIG_HOMIE}> · 0**`);
    expect(payload.content).toContain('_Nessun membro_');
    expect(payload.content).toContain('**2 membri Grape**');
  });

  it('esclude chi non è più nel server e usa i ruoli osservati su Discord', () => {
    const test = createTestAppContext();
    const payload = buildHierarchyPanel(
      [
        snapshot({
          discordId: '400000000000000001',
          nickname: 'Presente',
          roleIds: [test.ctx.roles.rank.LOC],
        }),
        snapshot({
          discordId: '400000000000000002',
          nickname: 'Uscito',
          roleIds: [test.ctx.roles.rank.RESIDENT],
          inGuild: false,
        }),
        // Due rank reali: compare in entrambi e sarà segnalato da sync-check.
        snapshot({
          discordId: '400000000000000003',
          nickname: 'Doppio rank',
          roleIds: [test.ctx.roles.rank.TINY_LOC, test.ctx.roles.rank.GANG_BANGER],
        }),
      ],
      test.ctx.roles,
    );

    expect(payload.content).toContain('• <@400000000000000001>');
    expect(payload.content).not.toContain('400000000000000002');
    expect(payload.content?.match(/400000000000000003/g)).toHaveLength(2);
  });

  it('marca come inattivo chi possiede il relativo ruolo Discord', () => {
    const test = createTestAppContext();
    const payload = buildHierarchyPanel(
      [
        snapshot({
          discordId: '400000000000000001',
          roleIds: [test.ctx.roles.rank.RESIDENT, test.ctx.roles.inactive],
        }),
      ],
      test.ctx.roles,
    );

    expect(payload.content).toContain('• <@400000000000000001> 💤');
  });

  it('le mention sono visibili ma non inviano ping', () => {
    const test = createTestAppContext();
    const payload = toApiMessage(
      buildHierarchyPanel(
        [
          snapshot({
            discordId: '400000000000000001',
            roleIds: [test.ctx.roles.rank.RESIDENT],
          }),
        ],
        test.ctx.roles,
      ),
    );

    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('usa il pannello persistente e aggiorna lo stesso messaggio', async () => {
    const test = createTestAppContext();
    const payload = buildHierarchyPanel([], test.ctx.roles);

    const first = await test.ctx.panels.publish({
      panelType: PanelType.HIERARCHY,
      channelId: CHANNEL_IDS.hierarchy,
      payload,
    });
    const second = await test.ctx.panels.publish({
      panelType: PanelType.HIERARCHY,
      channelId: CHANNEL_IDS.hierarchy,
      payload,
    });

    expect(first.action).toBe('created');
    expect(second).toEqual({ messageId: first.messageId, action: 'updated' });
    expect(test.sent).toHaveLength(1);
    expect(test.edited).toEqual([`${CHANNEL_IDS.hierarchy}:${first.messageId}`]);
  });

  it('resta sotto il limite Discord anche con molti membri', () => {
    const test = createTestAppContext();
    const many = Array.from({ length: 200 }, (_, index) =>
      snapshot({
        discordId: String(400000000000000000n + BigInt(index)),
        nickname: `Membro ${index.toString().padStart(3, '0')}`,
        roleIds: [test.ctx.roles.rank.GANG_BANGER],
      }),
    );

    const payload = buildHierarchyPanel(many, test.ctx.roles);
    expect(payload.content?.length).toBeLessThanOrEqual(2000);
    expect(payload.content).toContain('…e altri');
  });
});
