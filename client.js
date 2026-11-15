/**
 * Session cost window.
 *
 * A flat ledger card pinned to the right of the conversation. It folds the
 * Session's own durable usage into a cost, prices every request at the tier
 * (peak or off-peak) in force when that request settled, and shows the tier,
 * the countdown to the next switch, and the published unit prices.
 *
 * Mounted as a `conversation.composer.dock` entry and portalled to the page
 * body, because the docked composer is a containing block for fixed children.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const el = React.createElement
    const { useEffect, useState } = React

    // #region pure-helpers
    // Published list prices (CNY per 1M tokens, off-peak). Peak is exactly 2x.
    // Source: DeepSeek API pricing for deepseek-flash and deepseek-v4-pro.
    const SH_OFFSET = 8 * 60 * 60 * 1000
    const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
    const FLASH = { key: 'deepseek-flash', hit: 0.02, miss: 1, out: 4 }
    const PRO = { key: 'deepseek-v4-pro', hit: 0.15, miss: 4.5, out: 13.5 }
    const PRICES = { 'deepseek-flash': FLASH, 'deepseek-v4-pro': PRO }
    // Model names the vendor documents as served at Flash pricing.
    const ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    }

    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    function zeroTokens() {
      return { miss: 0, hit: 0, write: 0, out: 0 }
    }

    function zeroTier() {
      return { cost: 0, steps: 0, tokens: zeroTokens() }
    }

    function emptySnapshot() {
      return {
        hasMore: false,
        steps: [],
        stepCount: 0,
        total: 0,
        tokens: zeroTokens(),
        costByBucket: { miss: 0, hit: 0, write: 0, out: 0 },
        tiers: { peak: zeroTier(), offpeak: zeroTier() },
        model: '',
        price: priceFor(''),
        assumed: true,
        firstTime: 0,
        lastTime: 0,
      }
    }

    /** Shanghai wall-clock parts of an instant; China observes no DST. */
    function shParts(ms) {
      const d = new Date(ms + SH_OFFSET)
      return {
        day: d.getUTCDay(),
        mins: d.getUTCHours() * 60 + d.getUTCMinutes(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
      }
    }

    /** Billing tier at an instant: peak is Mon-Fri 09:00-12:00 and 14:00-18:00. */
    function tierAt(ms) {
      const p = shParts(ms)
      if (p.day === 0 || p.day === 6) return 'offpeak'
      for (const [from, to] of PEAK_WINDOWS) {
        if (p.mins >= from && p.mins < to) return 'peak'
      }
      return 'offpeak'
    }

    /** First future instant whose tier differs, or null beyond eight days. */
    function nextChangeAt(ms) {
      const current = tierAt(ms)
      let t = Math.floor(ms / 60000) * 60000 + 60000
      for (let i = 0; i < 8 * 1440; i += 1) {
        if (tierAt(t) !== current) return t
        t += 60000
      }
      return null
    }

    /** List price for a model name, with the assumed-flash fallback flagged. */
    function priceFor(model) {
      const name = String(model || '').toLowerCase()
      const key = PRICES[name] ? name : ALIASES[name]
      if (key && PRICES[key]) return { ...PRICES[key], model: name, assumed: false }
      return { ...FLASH, model: name || 'unknown', assumed: true }
    }

    /** Token cost of one bucket set at a tier, in CNY. */
    function costOfTokens(tokens, price, tier) {
      const factor = tier === 'peak' ? 2 : 1
      const missLike = num(tokens.miss) + num(tokens.write)
      return (missLike * price.miss + num(tokens.hit) * price.hit + num(tokens.out) * price.out) * factor / 1e6
    }

    function lastUsageChunk(stream) {
      if (!Array.isArray(stream)) return null
      for (let i = stream.length - 1; i >= 0; i -= 1) {
        const record = stream[i]
        if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
          return record.chunk.usage || null
        }
      }
      return null
    }

    function usageOfEvent(event) {
      const data = event && event.data
      if (!data) return null
      if (event.type === 'assistant/message') return data.usage || lastUsageChunk(data.stream)
      if (event.type === 'assistant/attempt') return lastUsageChunk(data.stream)
      return null
    }

    /**
     * Fold a Session event window into cost totals. Usage is keyed by turn:step
     * so a retried attempt replaces its earlier sample instead of adding to it.
     */
    function foldEntries(entries, hasMore) {
      const slots = new Map()
      let route = ''
      let order = 0
      for (const entry of entries || []) {
        if (!entry || entry.type !== 'event') continue
        const event = entry.event
        if (!event) continue
        const data = event.data || {}
        if (event.type === 'request/header') {
          const config = data.header && data.header.config
          if (config && config.model) route = String(config.model)
          continue
        }
        const usage = usageOfEvent(event)
        if (!usage) continue
        const model = (event.type === 'assistant/message'
          && data.message && data.message.source && data.message.source.model) || route
        slots.set(String(data.turn) + ':' + String(data.step), {
          time: num(event.time),
          model: model || '',
          usage,
          order: order++,
        })
      }

      const snapshot = emptySnapshot()
      snapshot.hasMore = Boolean(hasMore)

      for (const slot of slots.values()) {
        const usage = slot.usage
        const tokens = {
          miss: num(usage.inputTokens),
          hit: num(usage.cacheReadTokens),
          write: num(usage.cacheWriteTokens),
          out: num(usage.outputTokens),
        }
        const price = priceFor(slot.model)
        const tier = tierAt(slot.time)
        const cost = costOfTokens(tokens, price, tier)
        snapshot.steps.push({
          time: slot.time,
          tier,
          cost,
          tokens,
          model: price.model,
          assumed: price.assumed,
        })
        snapshot.total += cost
        snapshot.tokens.miss += tokens.miss
        snapshot.tokens.hit += tokens.hit
        snapshot.tokens.write += tokens.write
        snapshot.tokens.out += tokens.out
        snapshot.costByBucket.miss += costOfTokens({ miss: tokens.miss }, price, tier)
        snapshot.costByBucket.write += costOfTokens({ write: tokens.write }, price, tier)
        snapshot.costByBucket.hit += costOfTokens({ hit: tokens.hit }, price, tier)
        snapshot.costByBucket.out += costOfTokens({ out: tokens.out }, price, tier)
        const bucket = snapshot.tiers[tier]
        bucket.cost += cost
        bucket.steps += 1
        bucket.tokens.miss += tokens.miss
        bucket.tokens.hit += tokens.hit
        bucket.tokens.write += tokens.write
        bucket.tokens.out += tokens.out
        snapshot.model = price.model
        snapshot.price = { ...price }
        snapshot.assumed = price.assumed
        snapshot.firstTime = snapshot.firstTime === 0 ? slot.time : Math.min(snapshot.firstTime, slot.time)
        snapshot.lastTime = Math.max(snapshot.lastTime, slot.time)
      }

      snapshot.steps.sort((a, b) => (a.time - b.time) || (a.model < b.model ? -1 : 1))
      snapshot.stepCount = snapshot.steps.length
      return snapshot
    }

    /** ¥ text with a precision that stays readable across four orders of magnitude. */
    function money(value) {
      const v = num(value)
      if (v === 0) return '¥0'
      if (v < 0.0001) return '<¥0.0001'
      const digits = v < 0.01 ? 4 : v < 1 ? 3 : 2
      return '¥' + v.toFixed(digits)
    }

    /** Compact token count: 850, 12.3k, 1.24M. */
    function tokens(value) {
      const v = num(value)
      if (v < 1000) return String(Math.round(v))
      if (v < 1e6) return (v / 1e3).toFixed(v < 1e4 ? 1 : 0) + 'k'
      return (v / 1e6).toFixed(2) + 'M'
    }

    /** Cache-read share of prompt-side input as an integer percent. */
    function cacheHitPercent(tokensValue) {
      const prompt = num(tokensValue.miss) + num(tokensValue.hit) + num(tokensValue.write)
      if (prompt <= 0) return null
      return Math.round((num(tokensValue.hit) / prompt) * 100)
    }

    /** Split a duration into whole hours and minutes. */
    function splitDuration(ms) {
      const total = Math.max(0, Math.floor(num(ms) / 60000))
      return { hours: Math.floor(total / 60), minutes: total % 60 }
    }
    // #endregion pure-helpers

    const NS = 'session-cost-hud'

    const DICTS = {
      zh: {
        title: '会话成本',
        estimate: '估算',
        requests: '次请求',
        empty: '还没有计费请求',
        bucketMiss: '输入（缓存未命中）',
        bucketHit: '输入（缓存命中）',
        bucketWrite: '缓存写入',
        bucketOut: '输出',
        colTokens: 'tokens',
        colAmount: '金额',
        split: '高峰 / 谷时 花费占比',
        inPeak: '其中高峰',
        inOffpeak: '其中谷时',
        times: '次',
        peak: '高峰',
        offpeak: '谷时',
        priceByTier: '峰谷单价',
        unit: '¥ / 百万 tokens',
        intoPeak: '进入高峰',
        intoOffpeak: '进入谷时',
        after: '后',
        day: '天',
        hour: '小时',
        minute: '分',
        cacheHit: '缓存命中',
        partial: '仅已加载',
        updated: '更新于',
        caveat: '按已公布价目表估算，未含法定节假日日历。',
        assumed: '未知模型，按 deepseek-flash 计价',
      },
      en: {
        title: 'Session cost',
        estimate: 'estimate',
        requests: 'requests',
        empty: 'No billed request yet',
        bucketMiss: 'Input (miss)',
        bucketHit: 'Input (cached)',
        bucketWrite: 'Cache write',
        bucketOut: 'Output',
        colTokens: 'tokens',
        colAmount: 'amount',
        split: 'Peak / off-peak share',
        inPeak: 'Peak',
        inOffpeak: 'Off-peak',
        times: '',
        peak: 'Peak',
        offpeak: 'Off-peak',
        priceByTier: 'Unit price',
        unit: 'CNY / 1M tokens',
        intoPeak: 'Peak starts in',
        intoOffpeak: 'Off-peak starts in',
        after: '',
        day: 'd ',
        hour: 'h ',
        minute: 'm ',
        cacheHit: 'cache hit',
        partial: 'loaded history',
        updated: 'updated',
        caveat: 'Estimated from the published price list; holiday calendar not modelled.',
        assumed: 'Unknown model, priced as deepseek-flash',
      },
    }

    const CSS = `
.cst-card {
  --cst-inset-right: 32px;
  --cst-inset-top: 104px;
  position: fixed; top: var(--cst-inset-top); right: var(--cst-inset-right); z-index: 600;
  width: 302px; max-height: calc(100vh - 176px); overflow: auto;
  padding: 14px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base, #0e1014);
  color: var(--dsw-alias-label-primary, #e8ebf0);
  border: 1px solid var(--dsw-alias-border-l2, #333a45);
  border-radius: 12px;
  box-shadow: none;
  font: 12px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums;
  user-select: text;
}
.cst-card *, .cst-card *::before, .cst-card *::after { box-sizing: border-box; }
.cst-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.cst-title { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.cst-badge {
  display: inline-flex; align-items: center; gap: 5px;
  height: 20px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, #262b33);
  font-size: 11px; font-weight: 600;
}
.cst-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.cst-total { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15; }
.cst-muted { color: var(--dsw-alias-label-secondary, #98a1ad); }
.cst-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, #98a1ad); margin-bottom: 10px; }
.cst-table { width: 100%; border-collapse: collapse; }
.cst-table th {
  font-weight: 500; font-size: 10px; letter-spacing: 0.03em;
  color: var(--dsw-alias-label-secondary, #98a1ad);
  text-align: right; padding: 0 0 4px; white-space: nowrap;
}
.cst-table th:first-child, .cst-table td:first-child { text-align: left; }
.cst-table td { padding: 3px 0; text-align: right; white-space: nowrap; }
.cst-rule {
  height: 1px; margin: 10px 0; border: 0;
  background: var(--dsw-alias-border-l1, #262b33);
}
.cst-bar {
  display: flex; height: 6px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #1d2129);
}
.cst-bar > span { display: block; height: 100%; }
.cst-seg-peak { background: var(--dsw-alias-state-warn-primary, #e5a13c); }
.cst-seg-offpeak { background: var(--dsw-alias-state-success-primary, #43bd83); }
.cst-split-rows { margin-top: 6px; }
.cst-split-rows > div {
  display: flex; align-items: baseline; justify-content: space-between;
  font-size: 11.5px;
}
.cst-label { font-size: 10px; letter-spacing: 0.03em; color: var(--dsw-alias-label-secondary, #98a1ad); }
.cst-price th.current { color: var(--dsw-alias-label-primary, #e8ebf0); font-weight: 700; }
.cst-foot {
  display: flex; flex-direction: column; gap: 3px;
  margin-top: 10px;
  font-size: 10.5px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #98a1ad);
}
`

    /** Ref-counted cost source: starts its Session subscription on first reader. */
    function createCostSource(ctx, sessionId) {
      let snapshot = emptySnapshot()
      const listeners = new Set()
      let source = null
      let unsubscribe = null
      let release = null

      function recompute() {
        try {
          const window = source.getSnapshot()
          snapshot = foldEntries(window && window.entries, Boolean(window && window.hasMore))
        } catch (error) {
          snapshot = emptySnapshot()
        }
        for (const listener of [...listeners]) {
          try { listener() } catch (error) { /* one reader must not break the others */ }
        }
      }

      function start() {
        if (source) return
        try {
          let binding = ctx.sessions.binding(sessionId)
          if (!binding) {
            const reference = ctx.sessions.retain(sessionId, { source: 'costHud' })
            release = reference
            binding = reference.binding
          }
          source = binding.eventSource
          unsubscribe = source.subscribe(recompute)
          recompute()
        } catch (error) {
          source = null
        }
      }

      function stop() {
        if (unsubscribe) { unsubscribe(); unsubscribe = null }
        if (release) { try { release.release() } catch (error) { /* already released */ } release = null }
        source = null
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
      }
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    /** Local wall-clock label of the moment the card last recomputed. */
    function updatedLabel(ms) {
      const d = new Date(ms)
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    /** "进入高峰 · 2小时15分后", in whole days/hours once it is that far out. */
    function countdownText(t, now, tier) {
      const at = nextChangeAt(now)
      if (at === null) return null
      const remaining = Math.max(0, at - now)
      const { hours, minutes } = splitDuration(remaining)
      const days = Math.floor(hours / 24)
      const label = tier === 'peak' ? t('intoOffpeak') : t('intoPeak')
      let amount
      if (remaining < 60000) amount = '<1' + t('minute')
      else if (days > 0) amount = days + t('day') + (hours % 24) + t('hour')
      else if (hours > 0) amount = hours + t('hour') + minutes + t('minute')
      else amount = minutes + t('minute')
      return label + ' · ' + amount + t('after')
    }

    /** One ledger row: label, token count, amount actually billed for it. */
    function ledgerRow(t, key, count, amount) {
      return el('tr', { key },
        el('td', null, t(key)),
        el('td', { className: 'cst-muted' }, tokens(count)),
        el('td', null, money(amount)),
      )
    }

    function PriceTable({ t, price, tier }) {
      return el('table', { className: 'cst-table cst-price' },
        el('thead', null, el('tr', null,
          el('th', null, t('priceByTier')),
          el('th', { className: tier === 'offpeak' ? 'current' : undefined }, t('offpeak')),
          el('th', { className: tier === 'peak' ? 'current' : undefined }, t('peak')),
        )),
        el('tbody', null,
          [['bucketHit', price.hit], ['bucketMiss', price.miss], ['bucketOut', price.out]]
            .map(([key, base]) => el('tr', { key },
              el('td', null, t(key)),
              el('td', { className: tier === 'offpeak' ? undefined : 'cst-muted' }, '¥' + base.toFixed(2)),
              el('td', { className: tier === 'peak' ? undefined : 'cst-muted' }, '¥' + (base * 2).toFixed(2)),
            )),
          el('tr', { key: 'note' },
            el('td', { colSpan: 3, className: 'cst-muted', style: { paddingTop: '5px' } },
              t('unit') + ' · ' + (price.model || '—')
              + (price.assumed ? ' · ' + t('assumed') : '')),
          ),
        ),
      )
    }

    function CostCard(props) {
      const { t, now } = props
      const total = props.useCost((s) => s.total)
      const steps = props.useCost((s) => s.stepCount)
      const tokensValue = props.useCost((s) => s.tokens)
      const costByBucket = props.useCost((s) => s.costByBucket)
      const tiers = props.useCost((s) => s.tiers)
      const price = props.useCost((s) => s.price)
      const hasMore = props.useCost((s) => s.hasMore)

      const tier = tierAt(now)
      const hit = cacheHitPercent(tokensValue)
      const split = tiers.peak.cost + tiers.offpeak.cost
      const peakShare = split > 0 ? (tiers.peak.cost / split) * 100 : 0
      const rows = [
        ['bucketMiss', tokensValue.miss, costByBucket.miss],
        ['bucketHit', tokensValue.hit, costByBucket.hit],
        ['bucketWrite', tokensValue.write, costByBucket.write],
        ['bucketOut', tokensValue.out, costByBucket.out],
      ].filter((row) => row[1] > 0)
      const countdown = countdownText(t, now, tier)

      return el('section', { className: 'cst-card', 'aria-label': t('title') },
        el('style', { key: 'style' }, CSS),
        el('div', { className: 'cst-head' },
          el('span', { className: 'cst-title' }, t('title')),
          el('span', { className: 'cst-badge' },
            el('span', {
              className: 'cst-dot',
              style: {
                background: tier === 'peak'
                  ? 'var(--dsw-alias-state-warn-primary, #e5a13c)'
                  : 'var(--dsw-alias-state-success-primary, #43bd83)',
              },
            }),
            tier === 'peak' ? t('peak') : t('offpeak'),
          ),
        ),
        el('div', { className: 'cst-total' }, money(total)),
        el('div', { className: 'cst-sub' },
          t('estimate') + ' · ' + steps + ' ' + t('requests')
          + (hit === null ? '' : ' · ' + t('cacheHit') + ' ' + hit + '%')
          + (hasMore ? ' · ' + t('partial') : ''),
        ),
        el('table', { className: 'cst-table' },
          el('thead', null, el('tr', null,
            el('th', null, ''),
            el('th', null, t('colTokens')),
            el('th', null, t('colAmount')),
          )),
          el('tbody', null,
            rows.length === 0
              ? el('tr', { key: 'empty' },
                el('td', { colSpan: 3, className: 'cst-muted', style: { padding: '5px 0' } }, t('empty')))
              : rows.map(([key, count, amount]) => ledgerRow(t, key, count, amount)),
          ),
        ),
        el('hr', { className: 'cst-rule' }),
        el('div', { className: 'cst-label' }, t('split')),
        el('div', { className: 'cst-bar', 'aria-hidden': 'true' },
          el('span', { className: 'cst-seg-peak', style: { width: peakShare + '%' } }),
          el('span', { className: 'cst-seg-offpeak', style: { width: (100 - peakShare) + '%' } }),
        ),
        el('div', { className: 'cst-split-rows' },
          el('div', null,
            el('span', { className: 'cst-muted' }, t('inPeak') + ' · ' + tiers.peak.steps + t('times')),
            el('span', null, money(tiers.peak.cost)),
          ),
          el('div', null,
            el('span', { className: 'cst-muted' }, t('inOffpeak') + ' · ' + tiers.offpeak.steps + t('times')),
            el('span', null, money(tiers.offpeak.cost)),
          ),
        ),
        el('hr', { className: 'cst-rule' }),
        el(PriceTable, { t, price, tier }),
        el('div', { className: 'cst-foot' },
          countdown === null ? null : el('span', null, countdown),
          el('span', null, t('updated') + ' ' + updatedLabel(now)),
          el('span', null, t('caveat')),
        ),
      )
    }

    // One occurrence owns the window; a second (e.g. a sidebar chat) must not
    // paint a copy, and ownership must move on when the owner goes away.
    let primaryOwner = null
    const ownershipListeners = new Set()

    function claimOwnership(token) {
      if (primaryOwner !== null) return false
      primaryOwner = token
      return true
    }

    function releaseOwnership(token) {
      if (primaryOwner !== token) return
      primaryOwner = null
      for (const listener of [...ownershipListeners]) listener()
    }

    function Hud(props) {
      const fallback = (key) => DICTS.zh[key] || key
      const t = props.t || fallback
      const [primary, setPrimary] = useState(false)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        const token = {}
        const settle = () => setPrimary(claimOwnership(token))
        settle()
        ownershipListeners.add(settle)
        return () => {
          ownershipListeners.delete(settle)
          releaseOwnership(token)
        }
      }, [])

      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])

      if (!primary) return null
      return createPortal(el(CostCard, { ...props, t, now }), document.body)
    }

    return {
      // ctx.locale is read in apply(); Cordis only exposes injected services,
      // so omitting it leaves the plugin inactive instead of throwing.
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), 'session-cost-hud: zh')
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), 'session-cost-hud: en')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-cost-hud',
          order: 40,
          locale: NS,
          inject: (sessionId) => ({ hooks: { cost: createCostSource(ctx, sessionId) } }),
        }, Hud))
      },
    }
  },
})
;
//# sourceMappingURL=??@local/session-cost-hud/client.js.map&rev=65bbca1f8844
