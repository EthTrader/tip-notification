const Web3 = require('web3')
const { ethers } = require('ethers')
const { BigNumber, utils, constants } = ethers
const { formatUnits, Fragment, Interface, parseBytes32String } = utils
const snoowrap = require('snoowrap')
const Promise = require('bluebird')
const low = require('lowdb')
const { Pool } = require('pg')
const pool = new Pool({connectionString: process.env.DB_URL})
const FileAsync = require('lowdb/adapters/FileAsync')
const TippingABI = require('./abis/Tipping.json')
const ERC20ABI = require('./abis/ERC20.json')

const adapter = new FileAsync('db.json')
const r = new snoowrap({
  userAgent: 'EthTrader tipping 1.0 by u/EthTraderCommunity',
  clientId: process.env.REDDIT_SCRIPT_CLIENT_ID,
  clientSecret: process.env.REDDIT_SCRIPT_CLIENT_SECRET,
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD
})
const web3 = new Web3(process.env.WSS_PROVIDER)

const tipping = new web3.eth.Contract(TippingABI, process.env.TIPPING_ADDRESS)


let redditTipV1Frag = Fragment.from({
    "inputs": [
      {
        "name": "contentId",
        "type": "bytes12"
      }
    ],
    "name": "redditTipV1",
    "type": "function"
})
let ifaceV1 = new Interface([redditTipV1Frag])

let tips
main()

async function main(){
  const db = await low(adapter)
  tips = db.defaults({ tips: [] }).get('tips')
  let startBlock = process.env.START_BLOCK
  if(!startBlock)
    startBlock = await tipping.methods.getInitializationBlock().call()
  console.log("startBlock:", startBlock)
  let events = await eventsAfter(startBlock)
  let newEvents = events.filter(unprocessed)
  await Promise.all(newEvents.map(notify))
  tipping.events.Tip({fromBlock:'latest'})
    .on('data', notify)
}

async function eventsAfter(fromBlock){
  return await tipping.getPastEvents('Tip', {fromBlock})
}

function unprocessed({transactionHash}){
  let tip = tips.find({transactionHash}).value()
  return !tip
}

async function notify({transactionHash, returnValues}){
  const {from, to, amount, token, contentId} = returnValues

  const parsedContentId = parseBytes32String(contentId)
  console.log(parsedContentId)

  switch (parsedContentId.substr(0,3)){
    case "t1_":         // is comment
      await reply(await r.getComment(parsedContentId), {from, amount, transactionHash, token})
      break
    case "t3_":         // is post
      await reply(await r.getSubmission(parsedContentId), {from, amount, transactionHash, token})
      break
    default:
      console.log("no content id")
      break
  }
  await tips.push({transactionHash}).write()
}

async function reply(content, {from, amount, transactionHash, token}){
  const tokenContract = new web3.eth.Contract(ERC20ABI, token)
  const symbol = await tokenContract.methods.symbol().call()
  const decimals = await tokenContract.methods.decimals().call()

  const client = await pool.connect()
  const query = {
    // give the query a unique name
    name: 'fetch-user-by-address',
    text: 'SELECT * FROM users WHERE address ILIKE $1',
    values: [from],
  }
  let res = await client.query(query)
  client.release()
  // console.log(res)
  if(res.rows.length)
    from = `u/${res.rows[0].username}`
  else
    from = `${from.slice(0,8)}...`
  let txUrl = `${process.env.BLOCK_EXPLORER_TX_PATH}${transactionHash}`
  let message = `${from} [tipped](${txUrl}) you ${formatUnits(amount, decimals).toString()} ${symbol}!`
  console.log(content, message)
  try {
    await content.reply(message)
  } catch(e){
    console.log(e)
  }
  return
}
