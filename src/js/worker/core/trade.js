// @flow

import _ from 'underscore';
import {PHASE, PLAYER, g, helpers} from '../../common';
import {player, team} from '../core';
import {idb} from '../db';
import {logEvent, random} from '../util';
import type {TradePickValues, TradeSummary, TradeTeams} from '../../common/types';

/**
 * Start a new trade with a team.
 *
 * @memberOf core.trade
 * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs). If the other team's tid is null, it will automatically be determined from the pids.
 * @return {Promise}
 */
async function create(teams: TradeTeams) {
    const tr = await idb.cache.trade.get(0);

    // If nothing is in this trade, it's just a team switch, so keep the old stuff from the user's team
    if (teams[0].pids.length === 0 && teams[1].pids.length === 0 && teams[0].dpids.length === 0 && teams[1].dpids.length === 0) {
        teams[0].pids = tr.teams[0].pids;
        teams[0].dpids = tr.teams[0].dpids;
    }

    tr.teams = teams;

    await idb.cache.trade.put(tr);
}

/**
 * Gets the team ID for the team that the user is trading with.
 *
 * @memberOf core.trade
 * @return {er} Resolves to the other team's team ID.
 */
async function getOtherTid(): Promise<number> {
    const tr = await idb.cache.trade.get(0);
    return tr.teams[1].tid;
}

/**
 * Filter untradable players.
 *
 * If a player is not tradable, set untradable flag in the root of the object.
 *
 * @memberOf core.trade
 * @param {Array.<Object>} players Array of player objects or partial player objects
 * @return {Array.<Object>} Processed input
 */
function filterUntradable(players: {
    contract: {
        exp: number,
    },
    gamesUntilTradable: number,
}[]): {
    contract: {
        exp: number,
    },
    gamesUntilTradable: number,
    untradable: boolean,
    untradableMsg: string,
}[] {
    return players.map((p) => {
        if (p.contract.exp <= g.season && g.phase > PHASE.PLAYOFFS && g.phase < PHASE.FREE_AGENCY) {
            // If the season is over, can't trade players whose contracts are expired
            return Object.assign({}, p, {
                untradable: true,
                untradableMsg: 'Cannot trade expired contracts',
            });
        }

        if (p.gamesUntilTradable > 0) {
            // Can't trade players who recently were signed or traded
            return Object.assign({}, p, {
                untradable: true,
                untradableMsg: `Cannot trade recently-acquired player for ${p.gamesUntilTradable} more games`,
            });
        }

        return Object.assign({}, p, {
            untradable: false,
            untradableMsg: '',
        });
    });
}

/**
 * Is a player untradable.
 *
 * Just calls filterUntradable and discards everything but the boolean.
 *
 * @memberOf core.trade
 * @param {Object} p Player object or partial player object
 * @return {boolean} Processed input
 */
function isUntradable(p: any): boolean {
    return filterUntradable([p])[0].untradable;
}

/**
 * Validates that players are allowed to be traded and updates the database.
 *
 * If any of the player IDs submitted do not correspond with the two teams that are trading, they will be ignored.
 *
 * @memberOf core.trade
 * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
 * @return {Promise.<Array.<Object>>} Resolves to an array taht's the same as the input, but with invalid entries removed.
 */
async function updatePlayers(teams: TradeTeams): Promise<TradeTeams> {
    // Make sure each entry in teams has pids and dpids that actually correspond to the correct tid
    for (const t of teams) {
        // Check players
        const players = await idb.getCopies.players({tid: t.tid});
        const pidsGood = [];
        for (const p of players) {
            // Also, make sure player is not untradable
            if (t.pids.includes(p.pid) && !isUntradable(p)) {
                pidsGood.push(p.pid);
            }
        }
        t.pids = pidsGood;

        // Check draft picks
        const draftPicks = await idb.cache.draftPicks.indexGetAll('draftPicksByTid', t.tid);
        const dpidsGood = [];
        for (const dp of draftPicks) {
            if (t.dpids.includes(dp.dpid)) {
                dpidsGood.push(dp.dpid);
            }
        }
        t.dpids = dpidsGood;
    }

    let updated = false; // Has the trade actually changed?

    const tr = await idb.cache.trade.get(0);
    for (let i = 0; i < 2; i++) {
        if (teams[i].tid !== tr.teams[i].tid) {
            updated = true;
            break;
        }
        if (teams[i].pids.toString() !== tr.teams[i].pids.toString()) {
            updated = true;
            break;
        }
        if (teams[i].dpids.toString() !== tr.teams[i].dpids.toString()) {
            updated = true;
            break;
        }
    }

    if (updated) {
        tr.teams = teams;
        await idb.cache.trade.put(tr);
    }

    return teams;
}


/**
 * Create a summary of the trade, for eventual display to the user.
 *
 * @memberOf core.trade
 * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
 * @return {Promise.Object} Resolves to an object contianing the trade summary.
 */
async function summary(teams: TradeTeams): Promise<TradeSummary> {
    const tids = [teams[0].tid, teams[1].tid];
    const pids = [teams[0].pids, teams[1].pids];
    const dpids = [teams[0].dpids, teams[1].dpids];

    const s: TradeSummary = {
        teams: [{
            name: '',
            payrollAfterTrade: 0,
            picks: [],
            total: 0,
            trade: [],
        }, {
            name: '',
            payrollAfterTrade: 0,
            picks: [],
            total: 0,
            trade: [],
        }],
        warning: null,
    };

    // Calculate properties of the trade
    const promises = [];
    [0, 1].forEach(i => {
        promises.push(idb.cache.players.indexGetAll('playersByTid', tids[i]).then(async (playersTemp) => {
            let players = playersTemp.filter(p => pids[i].includes(p.pid));
            players = await idb.getCopies.playersPlus(players, {
                attrs: ['pid', 'name', 'contract'],
                season: g.season,
                tid: tids[i],
                showRookies: true,
                showNoStats: true,
            });
            s.teams[i].trade = players;
            s.teams[i].total = s.teams[i].trade.reduce((memo, p) => memo + p.contract.amount, 0);
        }));

        promises.push(idb.cache.draftPicks.indexGetAll('draftPicksByTid', tids[i]).then((picks) => {
            for (let j = 0; j < picks.length; j++) {
                if (dpids[i].includes(picks[j].dpid)) {
                    s.teams[i].picks.push({
                        dpid: picks[j].dpid,
                        desc: `${picks[j].season} ${picks[j].round === 1 ? "1st" : "2nd"} round pick (${g.teamAbbrevsCache[picks[j].originalTid]})`,
                    });
                }
            }
        }));
    });

    await Promise.all(promises);

    // Test if any warnings need to be displayed
    const overCap = [false, false];
    const ratios = [0, 0];
    await Promise.all([0, 1].map(async (j) => {
        const k = j === 0 ? 1 : 0;

        s.teams[j].name = `${g.teamRegionsCache[tids[j]]} ${g.teamNamesCache[tids[j]]}`;

        if (s.teams[j].total > 0) {
            ratios[j] = Math.floor((100 * s.teams[k].total) / s.teams[j].total);
        } else if (s.teams[k].total > 0) {
            ratios[j] = Infinity;
        } else {
            ratios[j] = 100;
        }

        const payroll = (await team.getPayroll(tids[j]))[0];
        s.teams[j].payrollAfterTrade = payroll / 1000 + s.teams[k].total - s.teams[j].total;
        if (s.teams[j].payrollAfterTrade > g.salaryCap / 1000) {
            overCap[j] = true;
        }
    }));

    if ((ratios[0] > 125 && overCap[0] === true) || (ratios[1] > 125 && overCap[1] === true)) {
        // Which team is at fault?;
        const j = ratios[0] > 125 ? 0 : 1;
        s.warning = `The ${s.teams[j].name} are over the salary cap, so the players it receives must have a combined salary of less than 125% of the salaries of the players it trades away.  Currently, that value is ${ratios[j]}%.`;
    }

    return s;
}


/**
 * Remove all players currently added to the trade.
 *
 * @memberOf core.trade
 * @return {Promise}
 */
async function clear() {
    const tr = await idb.cache.trade.get(0);

    for (const t of tr.teams) {
        t.pids = [];
        t.dpids = [];
    }


    await idb.cache.trade.put(tr);
}


const formatAssetsEventLog = (t) => {
    const strings = [];

    t.trade.forEach(p => strings.push(`<a href="${helpers.leagueUrl(["player", p.pid])}">${p.name}</a>`));
    t.picks.forEach(dp => strings.push(`a ${dp.desc}`));

    let text;
    if (strings.length === 0) {
        text = "nothing";
    } else if (strings.length === 1) {
        text = strings[0];
    } else if (strings.length === 2) {
        text = `${strings[0]} and ${strings[1]}`;
    } else {
        text = strings[0];
        for (let i = 1; i < strings.length; i++) {
            if (i === strings.length - 1) {
                text += `, and ${strings[i]}`;
            } else {
                text += `, ${strings[i]}`;
            }
        }
    }

    return text;
};

const processTrade = async (tradeSummary, tids, pids, dpids) => {
    for (const j of [0, 1]) {
        const k = j === 0 ? 1 : 0;

        for (const pid of pids[j]) {
            const p = await idb.cache.players.get(pid);
            p.tid = tids[k];
            // Don't make traded players untradable
            //p.gamesUntilTradable = 15;
            p.ptModifier = 1; // Reset
            if (g.phase <= PHASE.PLAYOFFS) {
                await player.addStatsRow(p, g.phase === PHASE.PLAYOFFS);
            }
            await idb.cache.players.put(p);
        }

        for (const dpid of dpids[j]) {
            const dp = await idb.cache.draftPicks.get(dpid);
            dp.tid = tids[k];
            await idb.cache.draftPicks.put(dp);
        }
    }
    if (dpids[0].length > 0 || dpids[1].length > 0) {
        idb.cache.markDirtyIndexes('draftPicks');
    }
    if (pids[0].length > 0 || pids[1].length > 0) {
        idb.cache.markDirtyIndexes('players');
    }

    logEvent({
        type: "trade",
        text: `The <a href="${helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[0]], g.season])}">${g.teamNamesCache[tids[0]]}</a> traded ${formatAssetsEventLog(tradeSummary.teams[0])} to the <a href="${helpers.leagueUrl(["roster", g.teamAbbrevsCache[tids[1]], g.season])}">${g.teamNamesCache[tids[1]]}</a> for ${formatAssetsEventLog(tradeSummary.teams[1])}.`,
        showNotification: false,
        pids: pids[0].concat(pids[1]),
        tids,
    });
};

/**
 * Proposes the current trade in the database.
 *
 * Before proposing the trade, the trade is validated to ensure that all player IDs match up with team IDs.
 *
 * @memberOf core.trade
 * @param {boolean} forceTrade When true (like in God Mode), this trade is accepted regardless of the AI
 * @return {Promise.<boolean, string>} Resolves to an array. The first argument is a boolean for whether the trade was accepted or not. The second argument is a string containing a message to be dispalyed to the user.
 */
async function propose(forceTrade?: boolean = false): Promise<[boolean, ?string]> {
    if (g.phase >= PHASE.AFTER_TRADE_DEADLINE && g.phase <= PHASE.PLAYOFFS) {
        return [false, "Error! You're not allowed to make trades now."];
    }

    const {teams} = await idb.cache.trade.get(0);

    const tids = [teams[0].tid, teams[1].tid];
    const pids = [teams[0].pids, teams[1].pids];
    const dpids = [teams[0].dpids, teams[1].dpids];

    // The summary will return a warning if (there is a problem. In that case,
    // that warning will already be pushed to the user so there is no need to
    // return a redundant message here.
    const s = await summary(teams);

    if (s.warning && !forceTrade) {
        return [false, null];
    }

    let outcome = "rejected"; // Default

    const dv = await team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids);

    if (dv > 0 || forceTrade) {
        // Trade players
        outcome = "accepted";

        await processTrade(s, tids, pids, dpids);
    }

    if (outcome === "accepted") {
        await clear();

        // Auto-sort CPU team roster
        for (const tid of tids) {
            if (!g.userTids.includes(tid)) {
                await team.rosterAutoSort(tid);
            }
        }

        return [true, 'Trade accepted! "Nice doing business with you!"'];
    }

    // Return a different rejection message based on how close we are to a deal. When dv < 0, the closer to 0, the better the trade for the AI.
    let message;
    if (dv > -5) {
        message = "Close, but not quite good enough.";
    } else if (dv > -10) {
        message = "That's not a good deal for me.";
    } else {
        message = 'What, are you crazy?!';
    }

    return [false, `Trade rejected! "${message}"`];
}

/**
 * Make a trade work
 *
 * Have the AI add players/picks until they like the deal. Uses forward selection to try to find the first deal the AI likes.
 *
 * @memberOf core.trade
 * @param {Array.<Object>} teams Array of objects containing the assets for the two teams in the trade. The first object is for the user's team and the second is for the other team. Values in the objects are tid (team ID), pids (player IDs) and dpids (draft pick IDs).
 * @param {boolean} holdUserConstant If true, then players/picks will only be added from the other team. This is useful for the trading block feature.
 * @param {?Object} estValuesCached Estimated draft pick values from trade.getPickValues, or null. Only pass if you're going to call this repeatedly, then it'll be faster if you cache the values up front.
 * @return {Promise.<?Object>} If it works, resolves to a teams object (similar to first input) with the "made it work" trade info. Otherwise, resolves to undefined
 */
async function makeItWork(
    teams: TradeTeams,
    holdUserConstant: boolean,
    estValuesCached?: TradePickValues,
): Promise<TradeTeams | void> {
    let initialSign;
    let added = 0;

    // Add either the highest value asset or the lowest value one that makes the trade good for the AI team.
    const tryAddAsset = async () => {
        const assets = [];

        if (!holdUserConstant) {
            // Get all players not in userPids
            const players = await idb.getCopies.players({tid: teams[0].tid});
            for (const p of players) {
                if (!teams[0].pids.includes(p.pid) && !isUntradable(p)) {
console.log('player team0', p.tid);
                    assets.push({
                        type: "player",
                        dv: 0,
                        pid: p.pid,
                        tid: teams[0].tid,
                    });
                }
            }
        }

        // Get all players not in otherPids
        const players = await idb.getCopies.players({tid: teams[1].tid});
        for (const p of players) {
            if (!teams[1].pids.includes(p.pid) && !isUntradable(p)) {
console.log('player team1', p.tid);
                assets.push({
                    type: "player",
                    dv: 0,
                    pid: p.pid,
                    tid: teams[1].tid,
                });
            }
        }

        if (!holdUserConstant) {
            // Get all draft picks not in userDpids
            const draftPicks = await idb.cache.draftPicks.indexGetAll('draftPicksByTid', teams[0].tid);
            for (const dp of draftPicks) {
                if (!teams[0].dpids.includes(dp.dpid)) {
                    assets.push({
                        type: "draftPick",
                        dv: 0,
                        dpid: dp.dpid,
                        tid: teams[0].tid,
                    });
                }
            }
        }

        // Get all draft picks not in otherDpids
        const draftPicks = await idb.cache.draftPicks.indexGetAll('draftPicksByTid', teams[1].tid);
        for (const dp of draftPicks) {
            if (!teams[1].dpids.includes(dp.dpid)) {
                assets.push({
                    type: "draftPick",
                    dv: 0,
                    dpid: dp.dpid,
                    tid: teams[1].tid,
                });
            }
        }

        // If we've already added 5 assets or there are no more to try, stop
        if (initialSign === -1 && (assets.length === 0 || added >= 5)) {
            return;
        }

        // Calculate the value for each asset added to the trade, for use in forward selection
        await Promise.all(assets.map(async (asset) => {
            const userPids = teams[0].pids.slice();
            const otherPids = teams[1].pids.slice();
            const userDpids = teams[0].dpids.slice();
            const otherDpids = teams[1].dpids.slice();

            if (asset.type === "player") {
                if (asset.tid === teams[0].tid) {
                    userPids.push(asset.pid);
                } else {
                    otherPids.push(asset.pid);
                }
            } else if (asset.tid === teams[0].tid) {
                userDpids.push(asset.dpid);
            } else {
                otherDpids.push(asset.dpid);
            }

            asset.dv = await team.valueChange(teams[1].tid, userPids, otherPids, userDpids, otherDpids, estValuesCached);
        }));

        assets.sort((a, b) => b.dv - a.dv);

        // Find the asset that will push the trade value the smallest amount above 0
        let j;
        for (j = 0; j < assets.length; j++) {
            if (assets[j].dv < 0) {
                break;
            }
        }
        if (j > 0) {
            j -= 1;
        }
        const asset = assets[j];
        if (asset.type === "player") {
            if (asset.tid === teams[0].tid) {
                teams[0].pids.push(asset.pid);
            } else {
                teams[1].pids.push(asset.pid);
            }
        } else if (asset.tid === teams[0].tid) {
            teams[0].dpids.push(asset.dpid);
        } else {
            teams[1].dpids.push(asset.dpid);
        }

        added += 1;

        // eslint-disable-next-line no-use-before-define
        return testTrade();
    };

    // See if the AI team likes the current trade. If not, try adding something to it.
    async function testTrade() {
        const dv = await team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, estValuesCached);

        if (dv > 0 && initialSign === -1) {
            return teams;
        }

        if ((added > 2 || (added > 0 && Math.random() > 0.5)) && initialSign === 1) {
            if (dv > 0) {
                return teams;
            }

            return;
        }

        return tryAddAsset();
    }

    const dv = await team.valueChange(teams[1].tid, teams[0].pids, teams[1].pids, teams[0].dpids, teams[1].dpids, estValuesCached);
    if (dv > 0) {
        // Try to make trade better for user's team
        initialSign = 1;
    } else {
        // Try to make trade better for AI team
        initialSign = -1;
    }

    return testTrade();
}

/**
 * Estimate draft pick values, based on the generated draft prospects in the database.
 *
 * This was made for team.valueChange, so it could be called once and the results cached.
 *
 * @memberOf core.trade
 * @return {Promise.Object} Resolves to estimated draft pick values.
 */
async function getPickValues(): Promise<TradePickValues> {
    const estValues = {
        default: [75, 73, 71, 69, 68, 67, 66, 65, 64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 50, 50, 49, 49, 49, 48, 48, 48, 47, 47, 47, 46, 46, 46, 45, 45, 45, 44, 44, 44, 43, 43, 43, 42, 42, 42, 41, 41, 41, 40, 40, 39, 39, 38, 38, 37, 37], // This is basically arbitrary
    };

    for (const tid of [PLAYER.UNDRAFTED, PLAYER.UNDRAFTED_2, PLAYER.UNDRAFTED_3]) {
        const players = await idb.cache.players.indexGetAll('playersByTid', tid);
        if (players.length > 0) {
            players.sort((a, b) => b.value - a.value);
            estValues[players[0].draft.year] = players.map(p => p.value + 4); // +4 is to generally make picks more valued
        }
    }

    return estValues;
}

/**
 * Make a trade work
 *
 * This should be called for a trade negotiation, as it will update the trade objectStore.
 *
 * @memberOf core.trade
 * @return {Promise.string} Resolves to a string containing a message to be dispalyed to the user, as if it came from the AI GM.
 */
async function makeItWorkTrade() {
    const [estValues, tr] = await Promise.all([
        getPickValues(),
        idb.cache.trade.get(0),
    ]);
    const teams0 = tr.teams;

    const teams = await makeItWork(helpers.deepCopy(teams0), false, estValues);

    if (teams === undefined) {
        return `${g.teamRegionsCache[teams0[1].tid]} GM: "I can't afford to give up so much."`;
    }

    const s = await summary(teams);

    // Store AI's proposed trade in database, if it's different
    let updated = false;

    for (let i = 0; i < 2; i++) {
        if (teams[i].tid !== teams0[i].tid) {
            updated = true;
            break;
        }
        if (teams[i].pids.toString() !== teams0[i].pids.toString()) {
            updated = true;
            break;
        }
        if (teams[i].dpids.toString() !== teams0[i].dpids.toString()) {
            updated = true;
            break;
        }
    }

    if (updated) {
        const tr2 = await idb.cache.trade.get(0);
        tr2.teams = teams;
        await idb.cache.trade.put(tr2);
    }

    if (s.warning) {
        return `${g.teamRegionsCache[teams[1].tid]} GM: "Something like this would work if you can figure out how to get it done without breaking the salary cap rules."`;
    }

    return `${g.teamRegionsCache[teams[1].tid]} GM: "How does this sound?"`;
}

const betweenAiTeams = async () => {
    const aiTids = _.range(g.numTeams).filter((i) => {
        return !g.userTids.includes(i);
    });
    if (aiTids.length === 0) {
        return;
    }
    const tid = random.choice(aiTids);

    const otherTids = _.range(g.numTeams).filter((i) => {
        return i !== tid && !g.userTids.includes(i);
    });
    if (otherTids.length === 0) {
        return;
    }
    const otherTid = random.choice(otherTids);

    const players = (await idb.getCopies.players({tid})).filter((p) => !isUntradable(p));
    const draftPicks = await idb.cache.draftPicks.indexGetAll('draftPicksByTid', tid);

    if (players.length === 0 && draftPicks.length === 0) {
        return;
    }

    const r = Math.random();

    const pids = [];
    const dpids = [];
    if (r < 0.33 || draftPicks.length === 0) {
        pids.push(random.choice(players).pid);
    } else if (r < 0.67 || players.length === 0) {
        dpids.push(random.choice(draftPicks).dpid);
    } else {
        pids.push(random.choice(players).pid);
        dpids.push(random.choice(draftPicks).dpid);
    }

    const teams0 = [{
        tid,
        pids,
        dpids,
    }, {
        tid: otherTid,
        pids: [],
        dpids: [],
    }];
    const teams = await makeItWork(teams0, false);
    if (teams === undefined) {
        return;
    }

    // Don't do trades of just picks, it's weird usually
    if (teams[0].pids.length === 0 && teams[1].pids.length === 0) {
        return;
    }

    // Don't do trades for nothing, it's weird usually
    if (teams[1].pids.length === 0 && teams[1].dpids.length === 0) {
        return;
    }

    const tradeSummary = await summary(teams);
    if (!tradeSummary.warning) {
        const finalTids = [teams[0].tid, teams[1].tid];
        const finalPids = [teams[0].pids, teams[1].pids];
        const finalDpids = [teams[0].dpids, teams[1].dpids];
        await processTrade(tradeSummary, finalTids, finalPids, finalDpids);
    }

/*    get all picks and players
    randomly pick 1-2

    pick a trade type, then pick an asset, then make it work (without forcing no new assets to the original team) with a random team. if it passes the salary cap, do it

    notification if notable enough (by value?)*/
};

export default {
    create,
    updatePlayers,
    getOtherTid,
    summary,
    clear,
    propose,
    makeItWork,
    makeItWorkTrade,
    filterUntradable,
    getPickValues,
    betweenAiTeams,
};
