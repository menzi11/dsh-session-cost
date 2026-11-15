// Cost-accounting checks for the shipped client bundle. The plugin has no build
// step, so the test reads the exact source the browser loads and runs the pure
// helpers inside its `pure-helpers` region.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const file = path.join(import.meta.dirname, '..', 'client.js')
const text = fs.readFileSync(file, 'utf8')
const start = text.indexOf('// #region pure-helpers')
const end = text.indexOf('// #endregion pure-helpers')
if (start < 0 || end < 0) throw new Error('pure-helper region markers not found in client.js')

const helpers = new Function(`${text.slice(start, end)}
return { tierAt, nextChangeAt, foldEntries, money, tokens, priceFor, costOfTokens, cacheHitPercent, splitDuration }
`)()

const SH = 8 * 3600 * 1000
const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - SH
const checks = []
const check = (name, actual, expected) => {
  assert.deepEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  checks.push(name)
}

// 2026-11-14 is a Saturday.
check('saturday 20:47 is off-peak', helpers.tierAt(at(2026, 11, 14, 20, 47)), 'offpeak')
check('monday 10:00 is peak', helpers.tierAt(at(2026, 11, 16, 10, 0)), 'peak')
check('monday 12:00 is off-peak', helpers.tierAt(at(2026, 11, 16, 12, 0)), 'offpeak')
check('monday 12:30 is off-peak', helpers.tierAt(at(2026, 11, 16, 12, 30)), 'offpeak')
check('monday 14:00 is peak', helpers.tierAt(at(2026, 11, 16, 14, 0)), 'peak')
check('friday 17:59 is peak', helpers.tierAt(at(2026, 11, 20, 17, 59)), 'peak')
check('friday 18:00 is off-peak', helpers.tierAt(at(2026, 11, 20, 18, 0)), 'offpeak')

check('saturday switches on monday 09:00', helpers.nextChangeAt(at(2026, 11, 14, 20, 47)), at(2026, 11, 16, 9, 0))
check('peak at 10:00 switches at 12:00', helpers.nextChangeAt(at(2026, 11, 16, 10, 0)), at(2026, 11, 16, 12, 0))
check('midday gap switches at 14:00', helpers.nextChangeAt(at(2026, 11, 16, 12, 30)), at(2026, 11, 16, 14, 0))

const flash = helpers.priceFor('deepseek-flash')
check('flash off-peak price', [flash.hit, flash.miss, flash.out, flash.assumed], [0.02, 1, 4, false])
check('legacy flash alias', [helpers.priceFor('deepseek-v4-flash').key, helpers.priceFor('deepseek-v4-flash').assumed], ['deepseek-flash', false])
check('unknown model falls back to flash', [helpers.priceFor('some-model').key, helpers.priceFor('some-model').assumed], ['deepseek-flash', true])

// 100k miss input + 900k cache hit + 2k output.
check('peak step cost', Number(helpers.costOfTokens({ miss: 100000, hit: 900000, out: 2000 }, flash, 'peak').toFixed(6)), 0.252)
check('off-peak step is half', Number(helpers.costOfTokens({ miss: 100000, hit: 900000, out: 2000 }, flash, 'offpeak').toFixed(6)), 0.126)

const event = (type, data, time) => ({ type: 'event', event: { type, seq: 1, time, data } })
const model = { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }
const entries = [
  event('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' }, at(2026, 11, 16, 10, 0)),
  event('assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', source: model }, stream: [],
    usage: { inputTokens: 100000, cacheReadTokens: 900000, outputTokens: 2000 },
  }, at(2026, 11, 16, 10, 1)),
  // Retry of the same step replaces the earlier sample.
  event('assistant/message', {
    turn: 1, step: 1, message: { role: 'assistant', source: model }, stream: [],
    usage: { inputTokens: 100000, cacheReadTokens: 900000, outputTokens: 2000 },
  }, at(2026, 11, 16, 10, 1)),
  event('assistant/message', {
    turn: 1, step: 2, message: { role: 'assistant', source: model }, stream: [],
    usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0 },
  }, at(2026, 11, 15, 22, 0)),
  { type: 'transient', event: { type: 'assistant/live-chunk', seq: 99, time: 0, data: {} } },
]

const snapshot = helpers.foldEntries(entries, true)
check('retried step counted once', snapshot.stepCount, 2)
check('total cost', Number(snapshot.total.toFixed(6)), 0.253)
check('peak bucket', [Number(snapshot.tiers.peak.cost.toFixed(6)), snapshot.tiers.peak.steps], [0.252, 1])
check('off-peak bucket', [Number(snapshot.tiers.offpeak.cost.toFixed(6)), snapshot.tiers.offpeak.steps], [0.001, 1])
check('ledger tokens', snapshot.tokens, { miss: 101000, hit: 900000, write: 0, out: 2000 })
check('last model', snapshot.model, 'deepseek-flash')
check('hasMore passes through', snapshot.hasMore, true)
check('cache hit percent', helpers.cacheHitPercent(snapshot.tokens), 90)
check('money formatting', [helpers.money(0), helpers.money(0.00002), helpers.money(0.0342), helpers.money(1.2345)], ['¥0', '<¥0.0001', '¥0.034', '¥1.23'])
check('token formatting', [helpers.tokens(999), helpers.tokens(12345), helpers.tokens(1234567)], ['999', '12k', '1.23M'])
check('duration split', helpers.splitDuration(2 * 3600 * 1000 + 13 * 60000), { hours: 2, minutes: 13 })
check('empty window', helpers.foldEntries([], false).stepCount, 0)

console.log(`${checks.length}/${checks.length} checks passed`)
