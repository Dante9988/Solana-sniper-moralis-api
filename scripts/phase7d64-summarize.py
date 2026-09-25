"""Summarize recorded local evidence; no network, database writes, or credentials."""
from pathlib import Path
from datetime import datetime
from collections import Counter
import json
import math
import re

ROOT = Path('/root/only-pump-me/docs/phase-7d6/evidence/7d6.4')
BACK = Path('/root/Solana-sniper-moralis-api')


def millis(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def quantiles(values):
    values = sorted(v for v in values if v >= 0)
    if not values:
        return {'n': 0, 'p50Ms': None, 'p95Ms': None, 'maxMs': None}
    return dict(n=len(values), p50Ms=round(values[math.ceil(len(values)*.5)-1]),
                p95Ms=round(values[math.ceil(len(values)*.95)-1]), maxMs=round(values[-1]))


acceptance = json.loads((ROOT/'verified/acceptance.json').read_text())
stages = []
for stage in acceptance['stages']:
    frames = [f for f in stage['frames'] if f['type'] == 'token.candle.updated'
              and f['data']['resolution'] == '1m' and f['receivedAt'] <= stage['liveEnd']]
    delays = []
    keys = ['startTime', 'open', 'high', 'low', 'close', 'volumeToken', 'volumeQuote', 'trades']
    for trade in stage['trades']:
        bucket = math.floor(millis(trade['sourceTimestamp']) / 60000) * 60
        frame = next((f for f in frames if f['data']['candle']['startTime'] == bucket
                      and int(f['data']['lastSourceHeight']) >= int(trade['sourceHeight'])
                      and millis(f['data']['candleCommittedAt']) >= millis(trade['observedAt'])), None)
        if frame:
            rendered = next((r for r in stage['renders'] if r['at'] >= frame['receivedAt']-20
                             and r['candle']['resolution'] == '1m'
                             and all(r['candle'].get(k) == frame['data']['candle'].get(k) for k in keys)), None)
            if rendered:
                delays.append(rendered['at'] - millis(trade['sourceTimestamp']))
    entry = {k: stage[k] for k in ['name', 'latency', 'canonicalTrades', 'liveCandleEvents',
             'exactRenderedMatches', 'switchCycles', 'duplicateTradeLinks', 'reconnect',
             'histories', 'historyResponses', 'errors']}
    entry['chainToRendered'] = quantiles(delays)
    entry['status429'] = sum(r['status'] == 429 for r in stage['requests'])
    entry['sharedReadRequestsDuringObservation'] = sum(r['at'] <= stage['liveEnd'] and
        any(p in r['path'] for p in ['/candles', '/market', '/history', '/trades']) for r in stage['requests'])
    for key in ['afterSignOutPublic', 'afterSignInAuthenticated']:
        entry[key] = stage.get(key)
    stages.append(entry)

basis = ('Local browser and server clock. Chain timestamp has second precision. indexedObservedAt is adapter '
         'observation before DB commit, not a commit timestamp. A trade is matched to the first captured candle '
         'commit with its bucket and lastSourceHeight >= trade height. Render is an exact canonical legend '
         'data-candle match observed on requestAnimationFrame, not a pixel presentation timestamp. '
         'No sums of independent percentiles.')
(ROOT/'latency-summary.json').write_text(json.dumps(dict(at=acceptance['at'], token=acceptance['token'],
                                                      basis=basis, stages=stages), indent=2))

rows = [json.loads(line) for line in (ROOT/'soak.jsonl').read_text().splitlines()]
samples = [r for r in rows if r['kind'] == 'sample']
complete = next((r for r in reversed(rows) if r['kind'] == 'complete'), None)
last = samples[-1]
start_ms = millis(rows[0]['at'])
end_ms = millis(complete['at'] if complete else rows[-1]['at'])
counts = Counter()
for line in (BACK/'.run/logs/pons.log').open():
    try:
        row = json.loads(line)
    except ValueError:
        continue
    if not start_ms <= row.get('time', 0) <= end_ms:
        continue
    message = row.get('msg', '')
    match = re.search(r'(\d+) trade\(s\) recorded', message)
    if match:
        counts['tradeWritesReportedByLiveTicks'] += int(match[1])
    match = re.search(r'(\d+) foreign log\(s\) dropped', message)
    if match:
        counts['foreignLogsDroppedReportedByLiveTicks'] += int(match[1])
    if row.get('level', 0) >= 40:
        counts['ponsWarningOrErrorLogEntries'] += 1

summary = dict(startedAt=rows[0]['at'], completedAt=complete['at'] if complete else None,
               elapsedMs=(complete or last)['elapsedMs'], sampleCount=len(samples),
               candleEvents=(complete or last)['received'], duplicateOrNonmonotonicRevisions=(complete or last)['duplicates'],
               reconnectAttempts=(complete or last)['reconnects'], latestTradeSample=last['trades'],
               latestCheckpoints=last['checkpoints'], pendingInvalidationsAtLastSample=last['pendingCandleInvalidations'],
               maxPendingInvalidations=max(r['pendingCandleInvalidations'] for r in samples),
               candleCommitToSocket=quantiles([r['receivedAt']-millis(r['data']['candleCommittedAt'])
                                              for r in rows if r['kind'] == 'candle']),
               reportedLiveTickCounters=dict(counts), errors=[r for r in rows if r['kind'] == 'error'],
               limitations=[
                   'Includes planned API/candle restarts and code changes; this is not an uninterrupted stable-release soak.',
                   'Reconnect count includes failed connection attempts during planned restarts, not only successful reconnects.',
                   'Live tick write counters are reported work, not unique event counts. Canonical counts come from PostgreSQL.',
                   'Full received/decoded/rejected event counters, queue depth, provider-error total and replay count are unavailable.',
                   'Memory snapshots list node processes visible to the collector; per-worker attribution was not established.',
                   'No zero is inferred for an unavailable metric.'])
(ROOT/'soak-summary.json').write_text(json.dumps(summary, indent=2))

doc = ROOT.parent.parent/'checkpoint-7d6.4.md'
text = doc.read_text()
labels = {'chainToIndexedObservedAt':'Chain → indexed observation',
          'indexedObservedAtToCandle':'Indexed observation → candle commit',
          'candleToPublished':'Candle commit → published', 'publishedToBrowser':'Published → browser',
          'candleToBrowser':'Candle commit → browser', 'candleToRendered':'Candle commit → rendered legend'}
table = '| Session | Stage | n | p50 | p95 | max |\n| --- | --- | ---: | ---: | ---: | ---: |\n'
for stage in stages:
    for key, label in labels.items():
        q = stage['latency'][key]
        table += f"| {stage['name']} | {label} | {q['n']} | {q['p50Ms']} | {q['p95Ms']} | {q['maxMs']} |\n"
    q = stage['chainToRendered']
    table += f"| {stage['name']} | Chain → rendered legend (matched directly) | {q['n']} | {q['p50Ms']} | {q['p95Ms']} | {q['maxMs']} |\n"
text = re.sub(r'\| Session \| Stage .*?(?=\nLocal browser)', table, text, flags=re.S)
text = text.replace('Frontend: 346 passed', 'Frontend: 347 passed')
if len(stages) == 2:
    guest, signed = stages
    text = re.sub(r'All\n\d+ captured live candle events matched rendered canonical OHLCV; guest matched\n\d+/\d+\.',
                  f"Signed-in rendered matches: {signed['exactRenderedMatches']}/{signed['liveCandleEvents']}; "
                  f"guest: {guest['exactRenderedMatches']}/{guest['liveCandleEvents']}. "
                  'A historical-bucket update need not change the latest-candle legend.', text)
if len(stages) == 2:
    text = re.sub(r'Signed-in rendered matches: \d+/\d+; guest: \d+/\d+\.',
                  f"Signed-in rendered matches: {signed['exactRenderedMatches']}/{signed['liveCandleEvents']}; guest: {guest['exactRenderedMatches']}/{guest['liveCandleEvents']}.", text)
if complete:
    text = re.sub(r'\nFinal observation:.*', '', text, flags=re.S)
    text = text.replace('The soak started at 09:18:31 UTC and is scheduled for at least 60 minutes.',
                        f"The soak ran from 09:18:31 UTC to {complete['at'][11:19]} UTC ({complete['elapsedMs']/60000:.2f} minutes).")
    text += f"\nFinal observation: {summary['candleEvents']} candle events, {summary['duplicateOrNonmonotonicRevisions']} duplicate/nonmonotonic revisions, " \
            f"{summary['reconnectAttempts']} reconnect attempts including planned restarts; " \
            f"{summary['pendingInvalidationsAtLastSample']} pending invalidations at the last sample. " \
            'See the structured soak summary for lag and telemetry limits.\n'
doc.write_text(text)
print(json.dumps({'soakComplete':bool(complete), 'elapsedMinutes':round(summary['elapsedMs']/60000,2),
                  'candles':summary['candleEvents'], 'duplicates':summary['duplicateOrNonmonotonicRevisions'],
                  'stages':[{'name':s['name'],'chainToRendered':s['chainToRendered']} for s in stages]}))
