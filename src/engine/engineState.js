// @flow
import type { AbcIo, DiskletFolder } from 'edge-login'

import { type PluginState, TIME_LAZINESS } from '../plugin/pluginState.js'
// import { scoreServer2 } from '../plugin/pluginState.js'
import type {
  StratumCallbacks,
  StratumTask
} from '../stratum/stratumConnection.js'

import {
  StratumConnection,
  KEEPALIVE_MS
} from '../stratum/stratumConnection.js'

import {
  broadcastTx,
  fetchScriptHashHistory,
  fetchScriptHashUtxo,
  fetchTransaction,
  fetchVersion,
  subscribeHeight,
  subscribeScriptHash,
  fetchBlockHeader
} from '../stratum/stratumMessages.js'

import type {
  StratumBlockHeader,
  StratumHistoryRow,
  StratumUtxo
} from '../stratum/stratumMessages.js'

import { parseTransaction } from './parseTransaction.js'

export type UtxoInfo = {
  txid: string, // tx_hash from Stratum
  index: number, // tx_pos from Stratum
  value: number // Satoshis fit in a number
}

export type AddressInfo = {
  txids: Array<string>,
  utxos: Array<UtxoInfo>,
  used: boolean, // Set by `addGapLimitAddress`
  displayAddress: string, // base58 or other wallet-ready format
  path: string, // TODO: Define the contents of this member.
  balance: number
}

export type AddressInfos = {
  [scriptHash: string]: AddressInfo
}

export interface EngineStateCallbacks {
  // Changes to an address UTXO set:
  +onBalanceChanged?: () => void;

  // Changes to an address 'use' state:
  +onAddressUsed?: () => void;

  // Changes to the chain height:
  +onHeightUpdated?: (height: number) => void;

  // Fetched a transaction from the network:
  +onTxFetched?: (txid: string) => void;
}

export interface EngineStateOptions {
  callbacks: EngineStateCallbacks;
  io: any;
  localFolder: any;
  encryptedLocalFolder: any;
  pluginState: PluginState;
  log?: Function;
}

function nop () {}

/**
 * This object holds the current state of the wallet engine.
 * It is responsible for staying connected to Stratum servers and keeping
 * this information up to date.
 */
export class EngineState {
  // On-disk address information:
  addressCache: {
    [scriptHash: string]: {
      txids: Array<string>,
      txidStratumHash: string,

      utxos: Array<UtxoInfo>,
      utxoStratumHash: string,

      displayAddress: string, // base58 or other wallet-ready format
      path: string // TODO: Define the contents of this member.
    }
  }

  // Dervived address information:
  addressInfos: AddressInfos

  // Maps from display addresses to script hashes:
  scriptHashes: { [displayAddress: string]: string }

  // Address usage information sent by the GUI:
  usedAddresses: { [scriptHash: string]: true }

  // On-disk hex transaction data:
  txCache: { [txid: string]: string }

  // Transaction height / timestamps:
  txHeightCache: {
    [txid: string]: {
      height: number,
      firstSeen: number // Timestamp for unconfirmed stuff
    }
  }

  // Cache of parsed transaction data:
  parsedTxs: { [txid: string]: any }

  // True if `startEngine` has been called:
  engineStarted: boolean

  // Active Stratum connection objects:
  connections: { [uri: string]: StratumConnection }

  // Status of active Stratum connections:
  serverStates: {
    [uri: string]: {
      fetchingHeight: boolean,
      fetchingVersion: boolean,

      // The server block height:
      // undefined - never subscribed
      // 0 - subscribed but no results yet
      // number - subscription result
      height: number | void,
      version: string | void,

      // Address subscriptions:
      addresses: {
        [scriptHash: string]: {
          subscribed: boolean,

          hash: string | null,
          // Timestamp of the last hash change.
          // The server with the latest timestamp "owns" an address for the sake
          // of fetching utxos and txids:
          lastUpdate: number,

          fetchingUtxos: boolean,
          fetchingTxids: boolean,
          subscribing: boolean
        }
      },

      // All txids this server knows about (from subscribes or whatever):
      // Servers that know about txids are eligible to fetch those txs.
      // If no server knows about a txid, anybody can try fetching it,
      // but there is no penalty for failing:
      txids: { [txid: string]: true },

      // All block headers this server knows about (from subscribes or whatever):
      // Servers that know about headers are eligible to fetch those headers.
      // If no server knows about a height, anybody can try fetching it,
      // but there is no penalty for failing:
      headers: { [height: string]: true }
    }
  }

  // True if somebody is currently fetching a transaction:
  fetchingTxs: { [txid: string]: boolean }

  // Transactions that are relevant to our addresses, but missing locally:
  missingTxs: { [txid: string]: true }

  // True if somebody is currently fetching a transaction:
  fetchingHeaders: { [height: string]: boolean }

  // Headres that are relevant to our transactions, but missing locally:
  missingHeaders: { [height: string]: true }

  addAddress (scriptHash: string, displayAddress: string, path: string) {
    if (this.addressCache[scriptHash]) return

    this.addressCache[scriptHash] = {
      txids: [],
      txidStratumHash: '',
      utxos: [],
      utxoStratumHash: '',
      used: false,
      displayAddress,
      path
    }
    this.scriptHashes[displayAddress] = scriptHash
    this.refreshAddressInfo(scriptHash)
    this.dirtyAddressCache()

    for (const uri of Object.keys(this.serverStates)) {
      this.serverStates[uri].addresses[scriptHash] = {
        fetchingTxids: false,
        fetchingUtxos: false,
        hash: null,
        lastUpdate: 0,
        subscribed: false,
        subscribing: false
      }
    }
  }

  markAddressesUsed (scriptHashes: Array<string>) {
    for (const scriptHash of scriptHashes) {
      this.usedAddresses[scriptHash] = true
      this.refreshAddressInfo(scriptHash)
    }
  }

  async saveKeys (keys: any) {
    try {
      const json = JSON.stringify({ keys: keys })
      await this.encryptedLocalFolder.file('keys.json').setText(json)
      this.log('Saved keys cache')
    } catch (e) {
      this.log('Error saving Keys', e)
    }
  }

  async loadKeys () {
    try {
      const keysCacheText = await this.encryptedLocalFolder
        .file('keys.json')
        .getText()
      const keysCacheJson = JSON.parse(keysCacheText)
      // TODO: Validate JSON
      return keysCacheJson.keys
    } catch (e) {
      this.log(e)
      return {}
    }
  }

  broadcastTx (rawTx: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const uris = Object.keys(this.connections).filter(
        uri => this.connections[uri].connected
      )
      // If we have no connections then error
      if (!uris || !uris.length) {
        reject(
          new Error('No available connections\nCheck your internet signal')
        )
      }
      let resolved = false
      let bad = 0

      const task = broadcastTx(
        rawTx,
        (txid: string) => {
          this.log(`Stratum broadcasted transaction ${txid}`)
          // We resolve if any server succeeds:
          if (!resolved) {
            resolved = true
            resolve(txid)
          }
        },
        (e: Error) => {
          // We fail if every server failed:
          if (++bad === uris.length) {
            this.log(
              `Stratum failed to broadcast transaction: ${rawTx}\n With error`,
              e
            )
            reject(e)
          }
        }
      )

      for (const uri of uris) {
        const connection = this.connections[uri]
        connection.submitTask(task)
      }
    })
  }

  /**
   * Called to complete a spend
   */
  saveTx (txid: string, rawTx: string) {
    this.handleTxidFetch(txid, -1)
    this.handleTxFetch(txid, rawTx)

    // Update the affected addresses:
    for (const scriptHash of this.findAffectedAddresses(txid)) {
      this.addressCache[scriptHash].txids.push(txid)
      this.refreshAddressInfo(scriptHash)
    }
    this.dirtyAddressCache()
  }

  connect () {
    this.pluginState.addEngine(this)
    this.engineStarted = true
    this.refillServers()
    this.cacheTimer = setInterval(() => {
      this.saveAddressCache()
      this.saveTxCache()
      if (this.pluginState) {
        this.pluginState.saveHeaderCache()
        this.pluginState.serverCache.serverCacheSave()
      }
    }, TIME_LAZINESS)
  }

  disconnect () {
    this.pluginState.removeEngine(this)
    this.engineStarted = false
    clearInterval(this.cacheTimer)
    clearTimeout(this.reconnectTimer)
    for (const uri of Object.keys(this.connections)) {
      console.log('engineState.js - disconnect - uri', uri)
      this.connections[uri].close()
      delete this.connections[uri]
    }
  }

  // ------------------------------------------------------------------------
  // Private stuff
  // ------------------------------------------------------------------------
  io: AbcIo
  localFolder: DiskletFolder
  encryptedLocalFolder: DiskletFolder
  pluginState: PluginState
  onBalanceChanged: () => void
  onAddressUsed: () => void
  onHeightUpdated: (height: number) => void
  onTxFetched: (txid: string) => void

  addressCacheDirty: boolean
  addressCacheTimestamp: number
  txCacheDirty: boolean
  txCacheTimestamp: number
  cacheTimer: number
  reconnectTimer: number
  log: Function

  constructor (options: EngineStateOptions) {
    this.addressCache = {}
    this.addressInfos = {}
    this.scriptHashes = {}
    this.usedAddresses = {}
    this.txCache = {}
    this.parsedTxs = {}
    this.txHeightCache = {}
    this.connections = {}
    this.serverStates = {}
    this.fetchingTxs = {}
    this.missingTxs = {}
    this.fetchingHeaders = {}
    this.missingHeaders = {}
    this.log = options.log || console.log
    this.io = options.io
    this.localFolder = options.localFolder
    this.encryptedLocalFolder = options.encryptedLocalFolder
    this.pluginState = options.pluginState
    const {
      onBalanceChanged = nop,
      onAddressUsed = nop,
      onHeightUpdated = nop,
      onTxFetched = nop
    } = options.callbacks
    this.onBalanceChanged = onBalanceChanged
    this.onAddressUsed = onAddressUsed
    this.onHeightUpdated = onHeightUpdated
    this.onTxFetched = onTxFetched

    this.addressCacheDirty = false
    this.addressCacheTimestamp = Date.now()
    this.txCacheDirty = false
    this.txCacheTimestamp = Date.now()
  }

  refillServers () {
    const { io } = this

    let i = 0
    const servers = this.pluginState.serverCache.getServers(8)
    this.log(`Refilling Servers, top 8 servers are:`, servers)
    while (Object.keys(this.connections).length < 3) {
      const uri = servers[i++]
      if (!uri) {
        this.reconnectTimer = setTimeout(() => this.refillServers(), 1000)
        break
      }
      if (/^electrums:/.test(uri)) {
        this.pluginState.serverCache.serverScoreDown(uri, 100)
        continue
      }

      if (!this.io.Socket && /^electrum:/.test(uri)) {
        this.pluginState.serverCache.serverScoreDown(uri, 100)
        continue
      }

      if (this.connections[uri]) {
        continue
      }

      const callbacks: StratumCallbacks = {
        onOpen: (uri: string) => {
          this.log(`Connected to ${uri}`)
        },
        onClose: (
          uri: string,
          badMessages: number,
          goodMessages: number,
          latency: number,
          hadError: boolean
        ) => {
          delete this.connections[uri]

          if (hadError) {
            this.pluginState.serverCache.serverScoreDown(uri)
          }

          if (this.engineStarted) {
            this.reconnectTimer = setTimeout(
              () => this.refillServers(),
              goodMessages ? 0 : KEEPALIVE_MS
            )
          }
          this.addressCacheDirty && this.saveAddressCache()
          this.txCacheDirty && this.saveTxCache()
        },

        onQueueSpace: uri => {
          const start = Date.now()
          const task = this.pickNextTask(uri)
          const taskMessage = task
            ? `${task.method} with params: ${task.params.toString()}`
            : 'No task Has been Picked'
          this.log(
            `Picked task: ${taskMessage}, for uri ${uri}, in: - ${Date.now() -
              start}ms`
          )
          return task
        },

        onNotifyHeader: (uri: string, headerInfo: StratumBlockHeader) => {
          this.log(`Stratum ${uri} notified header ${headerInfo.block_height}`)
          this.serverStates[uri].height = headerInfo.block_height
          this.pluginState.updateHeight(headerInfo.block_height)
        },

        onNotifyScriptHash: (uri: string, scriptHash: string, hash: string) => {
          this.log(`Stratum ${uri} notified scripthash ${scriptHash} change`)
          const addressState = this.serverStates[uri].addresses[scriptHash]
          addressState.hash = hash
          addressState.lastUpdate = Date.now()
        }
      }

      this.connections[uri] = new StratumConnection(
        uri,
        { callbacks, io },
        this.log
      )
      this.serverStates[uri] = {
        fetchingHeight: false,
        fetchingVersion: false,
        height: void 0,
        version: void 0,
        addresses: {},
        txids: new Set(),
        headers: new Set()
      }
      this.populateServerAddresses(uri)
      this.connections[uri].open()
    }
  }

  pickNextTask (uri: string): StratumTask | void {
    const serverState = this.serverStates[uri]

    // Check the version if we haven't done that already:
    if (serverState.version === void 0 && !serverState.fetchingVersion) {
      serverState.fetchingVersion = true
      const queryTime = Date.now()
      return fetchVersion(
        (version: string) => {
          this.log(`Stratum ${uri} received version ${version}`)
          serverState.fetchingVersion = false
          serverState.version = version
          this.pluginState.serverCache.serverScoreUp(
            uri,
            Date.now() - queryTime
          )
        },
        (e: Error) => {
          serverState.fetchingVersion = false
          this.onConnectionFail(uri, e, 'getting version')
        }
      )
    }

    // Subscribe to height if this has never happened:
    if (serverState.height === void 0 && !serverState.fetchingHeight) {
      serverState.fetchingHeight = true
      const queryTime = Date.now()
      return subscribeHeight(
        (height: number) => {
          this.log(`Stratum ${uri} received height ${height}`)
          serverState.fetchingHeight = false
          serverState.height = height
          this.pluginState.updateHeight(height)
          this.pluginState.serverCache.serverScoreUp(
            uri,
            Date.now() - queryTime
          )
        },
        (e: Error) => {
          serverState.fetchingHeight = false
          this.onConnectionFail(uri, e, 'subscribing to height')
        }
      )
    }

    // If this server is too old, bail out!
    // TODO: Stop checking the height in the Stratum message creator.
    // TODO: Check block headers to ensure we are on the right chain.
    if (!serverState.version) return
    if (serverState.version < '1.1') {
      this.connections[uri].close(
        new Error('Server protocol version is too old')
      )
      this.pluginState.serverCache.serverScoreDown(uri, 100)
      return
    }

    // Fetch Headers:
    for (const height of Object.keys(this.missingHeaders)) {
      if (
        !this.fetchingHeaders[height] &&
        this.serverCanGetHeader(uri, height)
      ) {
        this.fetchingHeaders[height] = true
        const queryTime = Date.now()
        return fetchBlockHeader(
          parseInt(height),
          (header: any) => {
            this.log(
              `Stratum ${uri} received header for block number ${height}`
            )
            this.fetchingHeaders[height] = false
            this.pluginState.serverCache.serverScoreUp(
              uri,
              Date.now() - queryTime
            )
            this.handleHeaderFetch(height, header)
          },
          (e: Error) => {
            this.fetchingHeaders[height] = false
            if (!serverState.headers[height]) {
              this.onConnectionFail(
                uri,
                e,
                `getting header for block number ${height}`
              )
            } else {
              // TODO: Don't penalize the server score either.
            }
          }
        )
      }
    }

    // Fetch txids:
    for (const txid of Object.keys(this.missingTxs)) {
      if (!this.fetchingTxs[txid] && this.serverCanGetTx(uri, txid)) {
        this.fetchingTxs[txid] = true
        const queryTime = Date.now()
        return fetchTransaction(
          txid,
          (txData: string) => {
            this.log(`Stratum ${uri} received tx ${txid}`)
            this.pluginState.serverCache.serverScoreUp(
              uri,
              Date.now() - queryTime
            )
            this.fetchingTxs[txid] = false
            this.handleTxFetch(txid, txData)
          },
          (e: Error) => {
            this.fetchingTxs[txid] = false
            if (!serverState.txids[txid]) {
              this.onConnectionFail(uri, e, `getting transaction ${txid}`)
            } else {
              // TODO: Don't penalize the server score either.
            }
          }
        )
      }
    }

    // Fetch utxos:
    for (const address of Object.keys(serverState.addresses)) {
      const addressState = serverState.addresses[address]
      if (
        addressState.hash &&
        addressState.hash !== this.addressCache[address].utxoStratumHash &&
        !addressState.fetchingUtxos &&
        this.findBestServer(address) === uri
      ) {
        addressState.fetchingUtxos = true
        const queryTime = Date.now()
        return fetchScriptHashUtxo(
          address,
          (utxos: Array<StratumUtxo>) => {
            this.log(`Stratum ${uri} received utxos for ${address}`)
            addressState.fetchingUtxos = false
            if (!addressState.hash) {
              throw new Error(
                'Blank stratum hash (logic bug - should never happen)'
              )
            }
            this.pluginState.serverCache.serverScoreUp(
              uri,
              Date.now() - queryTime
            )
            this.handleUtxoFetch(address, addressState.hash || '', utxos)
          },
          (e: Error) => {
            addressState.fetchingUtxos = false
            this.onConnectionFail(uri, e, `fetching utxos for ${address}`)
          }
        )
      }
    }

    // Subscribe to addresses:
    for (const address of Object.keys(this.addressCache)) {
      const addressState = serverState.addresses[address]
      if (!addressState.subscribed && !addressState.subscribing) {
        addressState.subscribing = true
        const queryTime = Date.now()
        return subscribeScriptHash(
          address,
          (hash: string | null) => {
            this.log(
              `Stratum ${uri} subscribed to ${address} at ${hash || 'null'}`
            )
            this.pluginState.serverCache.serverScoreUp(
              uri,
              Date.now() - queryTime
            )
            addressState.subscribing = false
            addressState.subscribed = true
            addressState.hash = hash
            addressState.lastUpdate = Date.now()
          },
          (e: Error) => {
            addressState.subscribing = false
            this.onConnectionFail(uri, e, `subscribing to address ${address}`)
          }
        )
      }
    }

    // Fetch history:
    for (const address of Object.keys(serverState.addresses)) {
      const addressState = serverState.addresses[address]
      if (
        addressState.hash &&
        addressState.hash !== this.addressCache[address].txidStratumHash &&
        !addressState.fetchingTxids &&
        this.findBestServer(address) === uri
      ) {
        addressState.fetchingTxids = true
        const queryTime = Date.now()
        return fetchScriptHashHistory(
          address,
          (history: Array<StratumHistoryRow>) => {
            this.log(`Stratum ${uri} received history for ${address}`)
            addressState.fetchingTxids = false
            if (!addressState.hash) {
              throw new Error(
                'Blank stratum hash (logic bug - should never happen)'
              )
            }
            this.pluginState.serverCache.serverScoreUp(
              uri,
              Date.now() - queryTime
            )
            this.handleHistoryFetch(address, addressState.hash || '', history)
          },
          (e: Error) => {
            addressState.fetchingTxids = false
            this.onConnectionFail(
              uri,
              e,
              `getting history for address ${address}`
            )
          }
        )
      }
    }
  }

  async load () {
    this.log('Loading wallet engine caches')

    // Load transaction data cache:
    try {
      const txCacheText = await this.localFolder.file('txs.json').getText()
      const txCacheJson = JSON.parse(txCacheText)

      // TODO: Validate JSON
      if (!txCacheJson.txs) throw new Error('Missing txs in cache')

      // Update the cache:
      this.txCacheTimestamp = Date.now()
      this.txCache = txCacheJson.txs

      // Update the derived information:
      for (const txid of Object.keys(this.txCache)) {
        this.parsedTxs[txid] = parseTransaction(this.txCache[txid])
      }
    } catch (e) {
      this.txCache = {}
    }

    // Load the address and height caches.
    // Must come after transactions are loaded for proper txid filtering:
    try {
      const cacheText = await this.localFolder.file('addresses.json').getText()
      const cacheJson = JSON.parse(cacheText)

      // TODO: Validate JSON
      if (!cacheJson.addresses) throw new Error('Missing addresses in cache')
      if (!cacheJson.heights) throw new Error('Missing heights in cache')

      // Update the cache:
      this.addressCacheTimestamp = Date.now()
      this.addressCache = cacheJson.addresses
      this.txHeightCache = cacheJson.heights

      // Fillup the missing headers to fetch
      for (const txid in this.txHeightCache) {
        const height = this.txHeightCache[txid].height
        if (!this.pluginState.headerCache[`${height}`]) {
          this.missingHeaders[`${height}`] = true
        }
      }

      // Update the derived information:
      for (const scriptHash of Object.keys(this.addressCache)) {
        const address = this.addressCache[scriptHash]
        for (const txid of address.txids) this.handleNewTxid(txid)
        for (const utxo of address.utxos) this.handleNewTxid(utxo.txid)
        this.scriptHashes[address.displayAddress] = scriptHash
        this.refreshAddressInfo(scriptHash)
      }
    } catch (e) {
      this.addressCache = {}
      this.addressInfos = {}
      this.txHeightCache = {}
    }

    return this
  }

  async clearCache () {
    this.addressCache = {}
    this.addressInfos = {}
    this.scriptHashes = {}
    this.usedAddresses = {}
    this.txCache = {}
    this.parsedTxs = {}
    this.txHeightCache = {}
    this.connections = {}
    this.serverStates = {}
    this.fetchingTxs = {}
    this.missingTxs = {}
    this.fetchingHeaders = {}
    this.missingHeaders = {}
    this.txCacheDirty = true
    this.addressCacheDirty = true
    await this.saveAddressCache()
    await this.saveTxCache()
  }

  saveAddressCache (): Promise<void> {
    if (this.addressCacheDirty) {
      const json = JSON.stringify({
        addresses: this.addressCache,
        heights: this.txHeightCache
      })

      return this.localFolder
        .file('addresses.json')
        .setText(json)
        .then(() => {
          this.log('Saved address cache')
          this.addressCacheDirty = false
          this.addressCacheTimestamp = Date.now()
        })
        .catch(e => this.log('saveAddressCache', e.message))
    }
    return Promise.resolve()
  }

  saveTxCache (): Promise<void> {
    if (this.txCacheDirty) {
      const json = JSON.stringify({ txs: this.txCache })

      return this.localFolder
        .file('txs.json')
        .setText(json)
        .then(() => {
          this.log('Saved tx cache')
          this.txCacheDirty = false
          this.txCacheTimestamp = Date.now()
        })
        .catch(e => this.log('saveTxCache', e.message))
    }
    return Promise.resolve()
  }

  dirtyAddressCache () {
    this.addressCacheDirty = true
    if (this.addressCacheTimestamp + TIME_LAZINESS < Date.now()) {
      this.saveAddressCache()
    }
  }

  dirtyTxCache () {
    this.txCacheDirty = true
    if (this.txCacheTimestamp + TIME_LAZINESS < Date.now()) {
      this.saveTxCache()
    }
  }

  findBestServer (address: string) {
    let bestTime = 0
    let bestUri = ''
    for (const uri of Object.keys(this.connections)) {
      const time = this.serverStates[uri].addresses[address].lastUpdate
      if (bestTime < time) {
        bestTime = time
        bestUri = uri
      }
    }
    return bestUri
  }

  serverCanGetTx (uri: string, txid: string) {
    // If we have it, we can get it:
    if (this.serverStates[uri].txids[txid]) return true

    // If somebody else has it, let them get it:
    for (const uri of Object.keys(this.connections)) {
      if (this.serverStates[uri].txids[txid]) return false
    }

    // If nobody has it, we can try getting it:
    return true
  }

  serverCanGetHeader (uri: string, height: string) {
    // If we have it, we can get it:
    if (this.serverStates[uri].headers[height]) return true

    // If somebody else has it, let them get it:
    for (const uri of Object.keys(this.connections)) {
      if (this.serverStates[uri].headers[height]) return false
    }

    // If nobody has it, we can try getting it:
    return true
  }

  // A server has sent a header, so update the cache and txs:
  handleHeaderFetch (height: string, header: any) {
    if (!this.pluginState.headerCache[height]) {
      this.pluginState.headerCache[height] = header
      const affectedTXIDS = this.findAffectedTransactions(height)
      for (const txid of affectedTXIDS) {
        if (this.parsedTxs[txid]) this.onTxFetched(txid)
      }
      this.pluginState.dirtyHeaderCache()
    }
    delete this.missingHeaders[height]
  }

  // A server has sent address history data, so update the caches:
  handleHistoryFetch (
    scriptHash: string,
    stateHash: string,
    history: Array<StratumHistoryRow>
  ) {
    // Process the txid list:
    const txidList: Array<string> = []
    for (const row of history) {
      txidList.push(row.tx_hash)
      this.handleTxidFetch(row.tx_hash, row.height)
    }

    // Save to the address cache:
    this.addressCache[scriptHash].txids = txidList
    this.addressCache[scriptHash].txidStratumHash = stateHash
    this.refreshAddressInfo(scriptHash)
    this.dirtyAddressCache()
  }

  // A server has sent a transaction, so update the caches:
  handleTxFetch (txid: string, txData: string) {
    this.txCache[txid] = txData
    delete this.missingTxs[txid]
    this.parsedTxs[txid] = parseTransaction(txData)
    for (const scriptHash of this.findAffectedAddressesforInputs(txid)) {
      this.refreshAddressInfo(scriptHash)
    }
    this.dirtyTxCache()
    this.onTxFetched(txid)
    for (const scriptHash of this.findAffectedAddressesforOutput(txid)) {
      this.refreshAddressInfo(scriptHash)
      for (const parsedTxid of this.addressInfos[scriptHash].txids) {
        const tx = this.parsedTxs[parsedTxid]
        for (const input of tx.inputs) {
          if (input.prevout) {
            const hash = input.prevout.rhash()
            if (hash === txid && this.parsedTxs[hash]) {
              this.onTxFetched(parsedTxid)
            }
          }
        }
      }
    }
  }

  // A server has told us about a txid, so update the caches:
  handleTxidFetch (txid: string, height: number) {
    height = height || -1
    // Save to the height cache:
    if (this.txHeightCache[txid]) {
      const prevHeight = this.txHeightCache[txid].height
      this.txHeightCache[txid].height = height
      if (
        this.parsedTxs[txid] &&
        (prevHeight === -1 || !prevHeight) &&
        height !== -1
      ) {
        this.onTxFetched(txid)
      }
    } else {
      this.txHeightCache[txid] = {
        firstSeen: Date.now(),
        height
      }
    }
    // Add to the missing headers list:
    if (height > 0 && !this.pluginState.headerCache[`${height}`]) {
      this.missingHeaders[`${height}`] = true
    }

    this.handleNewTxid(txid)
  }

  // Someone has detected a potentially new txid, so update tables:
  handleNewTxid (txid: string) {
    // Add to the relevant txid list:
    if (typeof this.fetchingTxs[txid] !== 'boolean') {
      this.fetchingTxs[txid] = false
    }

    // Add to the missing tx list:
    if (!this.txCache[txid]) {
      this.missingTxs[txid] = true
    }
  }

  // A server has sent UTXO data, so update the caches:
  handleUtxoFetch (
    scriptHash: string,
    stateHash: string,
    utxos: Array<StratumUtxo>
  ) {
    // Process the UTXO list:
    const utxoList: Array<UtxoInfo> = []
    for (const utxo of utxos) {
      utxoList.push({
        txid: utxo.tx_hash,
        index: utxo.tx_pos,
        value: utxo.value
      })
      this.handleTxidFetch(utxo.tx_hash, utxo.height)
    }

    // Save to the address cache:
    this.addressCache[scriptHash].utxos = utxoList
    this.addressCache[scriptHash].utxoStratumHash = stateHash
    this.refreshAddressInfo(scriptHash)
    this.dirtyAddressCache()
  }

  /**
   * If an entry changes in the address cache,
   * update the derived info:
   */
  refreshAddressInfo (scriptHash: string) {
    const address = this.addressCache[scriptHash]
    if (!address) return
    const { displayAddress, path } = address

    // It is used if it has transactions or if the metadata says so:
    const used =
      this.usedAddresses[scriptHash] ||
      address.txids.length + address.utxos.length !== 0

    // We only include existing stuff:
    const txids = address.txids.filter(txid => this.txCache[txid])
    const utxos = address.utxos.filter(utxo => this.txCache[utxo.txid])

    // Make a list of unconfirmed transactions for the utxo search:
    const pendingTxids = txids.filter(
      txid => this.txHeightCache[txid].height <= 0
    )

    // Add all our own unconfirmed outpoints to the utxo list:
    for (const txid of pendingTxids) {
      const tx = this.parsedTxs[txid]
      for (let i = 0; i < tx.outputs.length; ++i) {
        const output = tx.outputs[i]
        if (output.scriptHash === scriptHash) {
          utxos.push({ txid, index: i, value: output.value })
        }
      }
    }

    // Make a table of spent outpoints for filtering the UTXO list:
    const spends = {}
    for (const txid of pendingTxids) {
      const tx = this.parsedTxs[txid]
      for (const input of tx.inputs) {
        spends[`${input.prevout.rhash()}:${input.prevout.index}`] = true
      }
    }

    const utxosWithUnconfirmed = utxos.filter(
      utxo => !spends[`${utxo.txid}:${utxo.index}`]
    )

    const balance = utxosWithUnconfirmed.reduce((s, utxo) => utxo.value + s, 0)

    let prevBalance = 0
    let prevUsed = false
    if (this.addressInfos[scriptHash]) {
      prevBalance = this.addressInfos[scriptHash].balance
      prevUsed = this.addressInfos[scriptHash].used
    }

    // Assemble the info structure:
    this.addressInfos[scriptHash] = {
      txids,
      utxos: utxosWithUnconfirmed,
      used,
      displayAddress,
      path,
      balance
    }

    if (prevBalance !== balance) this.onBalanceChanged()
    if (prevUsed !== used) this.onAddressUsed()
  }

  findAffectedAddressesforInputs (txid: string): Array<string> {
    const scriptHashSet = []
    for (const input of this.parsedTxs[txid].inputs) {
      const prevTx = this.parsedTxs[input.prevout.rhash()]
      if (!prevTx) continue
      const prevOut = prevTx.outputs[input.prevout.index]
      if (!prevOut) continue
      scriptHashSet.push(prevOut.scriptHash)
    }
    return scriptHashSet
  }

  findAffectedAddressesforOutput (txid: string): Array<string> {
    const scriptHashSet = []
    for (const output of this.parsedTxs[txid].outputs) {
      if (this.addressCache[output.scriptHash]) {
        scriptHashSet.push(output.scriptHash)
      }
    }
    return scriptHashSet
  }

  findAffectedAddresses (txid: string): Array<string> {
    const inputs = this.findAffectedAddressesforInputs(txid)
    const outputs = this.findAffectedAddressesforOutput(txid)
    return inputs.concat(outputs)
  }

  // Finds the txids that a are in a block.
  findAffectedTransactions (height: string): Array<string> {
    const txids = []
    for (const txid in this.txHeightCache) {
      const tx = this.txHeightCache[txid]
      if (`${tx.height}` === height) txids.push(txid)
    }
    return txids
  }

  onConnectionFail (uri: string, e: Error, task: string) {
    this.log(`Stratum ${uri} failed with message "${e.message}" while ${task}`)
    if (this.connections[uri]) {
      this.connections[uri].close(e)
    }
  }

  populateServerAddresses (uri: string) {
    const serverState = this.serverStates[uri]
    for (const address of Object.keys(this.addressCache)) {
      if (!serverState.addresses[address]) {
        serverState.addresses[address] = {
          fetchingTxids: false,
          fetchingUtxos: false,
          hash: null,
          lastUpdate: 0,
          subscribed: false,
          subscribing: false
        }
      }
    }
  }
}
