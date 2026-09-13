#!/usr/bin/env node
// Golden fixture for admission control: the token bucket's answers over a
// stepped clock, and the scheduler's pick order for a fixed set of waiting
// tasks.
//
// Regenerate with:  node scripts/gen-queue-fixture.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActorRateLimiter } from '../src/main/core/queue.ts'

let clock = 0
const limiter = new ActorRateLimiter({ capacity: 5, refillPerSec: 10, now: () => clock })

const bucketSteps: { at: number; actor: string; tokens: number; allowed: boolean }[] = []
const take = (actor: string, tokens = 1) =>
  bucketSteps.push({ at: clock, actor, tokens, allowed: limiter.tryConsume(actor, tokens) })

// A fresh actor starts with a full bucket.
for (let i = 0; i < 5; i++) take('alice')
// Sixth in the same instant is refused.
take('alice')
// A different actor has its own bucket.
take('bob')
// 100ms buys one token back at 10/sec.
clock += 100
take('alice')
take('alice')
// A full second refills to capacity, not beyond.
clock += 1_000
for (let i = 0; i < 6; i++) take('alice')
// A multi-token request is all-or-nothing.
clock += 1_000
take('alice', 20)
take('alice', 5)

limiter.reset('alice')
clock += 1
take('alice')

const outFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'native', 'orcspace-app', 'tests', 'fixtures', 'queue-admission.json'
)
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify({ capacity: 5, refillPerSec: 10, bucketSteps }, null, 2) + '\n', 'utf8')
console.log(`Wrote ${bucketSteps.length} bucket steps`)
for (const s of bucketSteps) console.log(`  ${String(s.at).padStart(5)}ms ${s.actor} x${s.tokens} -> ${s.allowed ? 'allowed' : 'refused'}`)
