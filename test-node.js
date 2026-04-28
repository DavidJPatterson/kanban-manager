#!/usr/bin/env node
// test-node.js — Run unit tests in Node.js (CI-compatible)
// Mocks browser globals, then loads the same shared.js + test.js used by test.html

const fs = require('fs')
const vm = require('vm')
const path = require('path')

// Track failures via console.error calls from test.js
let failCount = 0
const interceptedConsole = {
  ...console,
  error(...args) {
    const msg = args.join(' ')
    if (msg.includes('FAIL:')) failCount++
    console.error(...args)
  }
}

// Minimal browser/chrome API mock
const context = vm.createContext({
  console: interceptedConsole,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  Array,
  Object,
  Map,
  Set,
  String,
  Number,
  JSON,
  Promise,
  Infinity,
  parseInt,
  parseFloat,
  isNaN,
  btoa: str => Buffer.from(str).toString('base64'),
  fetch: () => Promise.reject(new Error('fetch not available in test')),
  AbortController: class { constructor() { this.signal = {} } abort() {} },
  CSS: { escape: s => s.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&') },
  chrome: {
    storage: { local: { get() {}, set() {}, remove() {} }, onChanged: { addListener() {} } },
    runtime: { sendMessage() {}, onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } }
  },
  document: { addEventListener() {}, getElementById() { return null } },
  window: {}
})

function loadFile(name) {
  const code = fs.readFileSync(path.join(__dirname, name), 'utf-8')
  vm.runInContext(code, context, { filename: name })
}

// Load shared.js (defines all functions as globals in context)
loadFile('shared.js')
loadFile('weekly-update.js')

// Load test.js (runs all tests, reports via console)
loadFile('test.js')

// Exit with failure code if any tests failed
process.exit(failCount > 0 ? 1 : 0)
