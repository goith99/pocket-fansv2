// Winner resolution: map a finished fixture's goals to the winning ParticipantId
// (== our team_id). Handles the group-stage draw vs knockout-penalties quirk.
// `result` comes from txline.getFinishedResult and already carries the
// participant metadata (participant1Id/participant2Id/participant1IsHome).

// -> { winningTeamId: number (0 = draw/none), reason: string }
function resolveWinner(result, isKnockout) {
  const homeId = result.participant1IsHome ? result.participant1Id : result.participant2Id;
  const awayId = result.participant1IsHome ? result.participant2Id : result.participant1Id;
  const { homeGoals, awayGoals, homePens, awayPens, hasPens } = result;

  if (homeGoals > awayGoals) return { winningTeamId: homeId, reason: `home wins ${homeGoals}-${awayGoals}` };
  if (awayGoals > homeGoals) return { winningTeamId: awayId, reason: `away wins ${awayGoals}-${homeGoals}` };

  // level after full time
  if (isKnockout) {
    if (hasPens && homePens !== awayPens) {
      return homePens > awayPens
        ? { winningTeamId: homeId, reason: `level ${homeGoals}-${awayGoals}, home wins pens ${homePens}-${awayPens}` }
        : { winningTeamId: awayId, reason: `level ${homeGoals}-${awayGoals}, away wins pens ${awayPens}-${homePens}` };
    }
    return { winningTeamId: 0, reason: `level ${homeGoals}-${awayGoals}, knockout but no penalty result yet` };
  }
  return { winningTeamId: 0, reason: `draw ${homeGoals}-${awayGoals} (group stage)` };
}

module.exports = { resolveWinner };
