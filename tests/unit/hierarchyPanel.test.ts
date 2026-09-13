import { describe, expect, it } from 'vitest';
import { MemberRank, MemberStatus, PanelType } from '../../src/generated/prisma/enums.js';
import { buildHierarchyPanel } from '../../src/components/embeds/hierarchyPanel.js';
import { toApiMessage } from '../../src/discord/payload.js';
import type { Member } from '../../src/repositories/types.js';
import { createTestAppContext } from '../support/appContext.js';
import { CHANNEL_IDS } from '../support/harness.js';

function member(
  discordId: string,
  rank: MemberRank,
  status: MemberStatus = MemberStatus.ACTIVE,
  rpName: string | null = null,
): Member {
  const now = new Date('2026-09-13T00:00:00Z');
  return {
    id: `member_${discordId}`,
    discordId,
    rpName,
    rpSurname: null,
    citizenId: null,
    phone: null,
    rank,
    status,
    joinedTtpAt: now,
    leftTtpAt: null,
    recruitedByDiscordId: null,
    notes: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('pannello gerarchia', () => {
  it('mostra i nove ruoli dall’alto verso il basso e i membri sotto ciascuno', () => {
    const test = createTestAppContext();
    const payload = toApiMessage(
      buildHierarchyPanel(
        [
          member('400000000000000001', MemberRank.GANG_BANGER, MemberStatus.ACTIVE, 'Zeta'),
          member('400000000000000002', MemberRank.OG, MemberStatus.ACTIVE, 'Boss'),
          member('400000000000000003', MemberRank.GANG_BANGER, MemberStatus.INACTIVE, 'Alpha'),
          // Non fa più parte della gang: non deve comparire nel pannello.
          member('400000000000000004', MemberRank.OG, MemberStatus.LEFT, 'Ex membro'),
        ],
        test.ctx.roles,
      ),
    );

    const embed = payload.embeds?.[0];
    expect(embed?.title).toBe('🏛️ GERARCHIA TTP');
    expect(embed?.fields).toHaveLength(9);
    expect(embed?.fields?.[0]?.name).toBe(`<@&${test.ctx.roles.rank.OG}> · 1`);
    expect(embed?.fields?.[0]?.value).toBe('• <@400000000000000002>');

    const gangBanger = embed?.fields?.find((field) =>
      field.name.startsWith(`<@&${test.ctx.roles.rank.GANG_BANGER}>`),
    );
    expect(gangBanger?.name).toContain('· 2');
    // Ordine alfabetico per nome RP; l'inattivo è riconoscibile.
    expect(gangBanger?.value).toBe('• <@400000000000000003> 💤\n• <@400000000000000001>');
    expect(embed?.footer?.text).toBe('3 membri TTP · 💤 = inattivo');
  });

  it('le mention sono visibili ma non inviano ping', () => {
    const test = createTestAppContext();
    const payload = toApiMessage(
      buildHierarchyPanel([member('400000000000000001', MemberRank.RESIDENT)], test.ctx.roles),
    );

    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('usa il pannello persistente e aggiorna lo stesso messaggio', async () => {
    const test = createTestAppContext();
    const payload = buildHierarchyPanel(
      [member('400000000000000001', MemberRank.RESIDENT)],
      test.ctx.roles,
    );

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
});
