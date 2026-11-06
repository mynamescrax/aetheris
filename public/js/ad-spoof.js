(function(){if(window.__adSpoofInstalled)return;window.__adSpoofInstalled=true
var n=function(){},r=function(){return Promise.resolve(1)},f=function(){return Promise.resolve(0)}

// Offline Poki bundles have blank ad/config URLs and cannot initialize IMA.
// Keep the game lifecycle available without starting that broken ad backend.
var poki={init:function(){return Promise.resolve()},commercialBreak:function(){return Promise.resolve()},rewardedBreak:function(){return Promise.resolve(false)},gameLoadingStart:n,gameLoadingFinished:n,gameLoadingProgress:n,gameplayStart:n,gameplayStop:n,setDebug:n,captureError:n,getURLParam:function(key){try{return new URLSearchParams(window.location.search).get(key)}catch(e){return null}}}
var pokisdk=Object.assign({},window.PokiSDK||{},poki)
Object.defineProperty(window,'PokiSDK',{get:function(){return pokisdk},set:function(value){pokisdk=Object.assign({},value||{},poki)},configurable:true})

function C(){return{isAvailable:1,adAvailable:1,hasAdBlock:f,
showBanner:n,hideBanner:n,clearBannerAd:n,requestBannerAd:n,preloadBannerAd:r,
requestAd:function(t,e){var o=e||{};setTimeout(function(){try{if(typeof o.onAdStarted=='function')o.onAdStarted()}catch(e){}setTimeout(function(){try{if(typeof o.onAdFinished=='function')o.onAdFinished()}catch(e){}},80)},50)},
preloadInterstitial:r,showInterstitial:function(t,e){setTimeout(function(){try{if(typeof e=='function')e(1)}catch(e){}},50);return r()},
preloadRewarded:r,showRewarded:function(t){setTimeout(function(){try{if(typeof t=='function')t(1)}catch(e){}},50);return r()},
sdkGameLoadingStart:n,sdkGameLoadingStop:n,gameplayStart:n,gameplayStop:n,on:n,off:n,once:n}}

window.CrazyGames=window.CrazyGames||{};if(!window.CrazyGames.SDK)window.CrazyGames.SDK=C()
var O=null;function E(n){if(O&&typeof O.onEvent=='function')try{O.onEvent({name:n})}catch(e){}}
Object.defineProperty(window,'SDK_OPTIONS',{get:function(){return O},set:function(n){O=n;if(n&&typeof n.onEvent=='function')setTimeout(function(){E('SDK_READY')},30)},configurable:1})
var S=C();S.showAd=function(){E('SDK_GAME_PAUSE');setTimeout(function(){E('SDK_GAME_START')},120)}
var c=window.sdk||S;Object.defineProperty(window,'sdk',{get:function(){return c},set:function(n){if(n&&!n.__spoofed){n.__spoofed=1;var e=n.showAd;n.showAd=function(){E('SDK_GAME_PAUSE');setTimeout(function(){E('SDK_GAME_START')},120);if(typeof e=='function')try{e.apply(n,arguments)}catch(e){}};['showInterstitial','showRewarded'].forEach(function(t){if(typeof n[t]!='function')return;var o=n[t];n[t]=function(t,e){var i=typeof t=='function'?t:typeof e=='function'?e:null;setTimeout(function(){try{if(i)i(1)}catch(e){}},50);try{return o.apply(n,arguments)}catch(e){}return r()}})}return c=n||S},configurable:1})
var L={};function A(n,t){(L[n]||[]).forEach(function(e){try{e(t)}catch(e){}})}
var B={isBannerSupported:0,minimumDelayBetweenInterstitial:0,rewardedPlacement:null,
on:function(n,t){(L[n]=L[n]||[]).push(t)},off:function(n,t){if(L[n])L[n]=L[n].filter(function(e){return e!==t})},
checkAdBlock:f,showBanner:function(){setTimeout(function(){A('banner_state_changed','shown')},50)},
hideBanner:function(){setTimeout(function(){A('banner_state_changed','hidden')},50)},
get interstitialState(){return'closed'},setMinimumDelayBetweenInterstitial:n,
showInterstitial:function(){setTimeout(function(){A('interstitial_state_changed','opened');setTimeout(function(){A('interstitial_state_changed','closed')},100)},50)},
showRewarded:function(n){B.rewardedPlacement=n||null;setTimeout(function(){A('rewarded_state_changed','opened');setTimeout(function(){A('rewarded_state_changed','rewarded');setTimeout(function(){A('rewarded_state_changed','closed')},50)},100)},50)}}
window.bridge=window.bridge||{};if(!window.bridge.advertisement)window.bridge.advertisement=B
window.bridge.platform=window.bridge.platform||{id:'mock',language:'en',payload:null,tld:null,sendMessage:n}
window.bridge.device=window.bridge.device||{type:'desktop'}
window.bridge.player=window.bridge.player||{isAuthorizationSupported:0,isAuthorized:0,id:null,name:null,photos:[]}
window.bridge.game=window.bridge.game||{on:n,off:n,visibilityState:'visible'}
window.bridge.storage=window.bridge.storage||{defaultType:'local_storage',isSupported:function(){return 1},isAvailable:function(){return 1},get:function(){return Promise.resolve(null)},set:function(){return Promise.resolve(null)},delete:function(){return Promise.resolve(null)}}
window.PokiSDK=window.PokiSDK||{rewardedBreak:function(n){return new Promise(function(t){setTimeout(function(){try{if(n&&typeof n.onStart=='function')n.onStart()}catch(e){}setTimeout(function(){t({rewardGranted:1})},50)},50)})},commercialBreak:r,gameLoadingStart:n,gameLoadingFinished:n,gameplayStart:n,gameplayStop:n,displayAd:r,setDebug:n}
function Q(n){if(!n||n.__spoofed)return;n.__spoofed=1;var t=Array.prototype.push;n.push=function(e){if(typeof e=='function')setTimeout(e,0);return t.call(this,e)};n.forEach(function(e){if(typeof e=='function')setTimeout(e,0)})}
function P(n){if(!n||!n.cmd)return;Q(n.cmd.display=n.cmd.display||[]);Q(n.cmd.player=n.cmd.player||[])}
var V=window.aiptag||null;Object.defineProperty(window,'aiptag',{get:function(){return V},set:function(n){V=n;P(n)},configurable:1});P(V)
if(!window.aipPlayer)window.aipPlayer=function(n){this.startPreRoll=function(){if(n&&typeof n.AIP_COMPLETE=='function')setTimeout(function(){try{n.AIP_COMPLETE('empty')}catch(e){}},80)}}
if(!window.aipDisplayTag)window.aipDisplayTag={display:n}
// Google ad libraries are only given passive, queue-shaped placeholders: if
// the real GPT/AdSense script loads, it finds the standard `cmd`/`push`
// arrays and initializes normally. Faking ready-made slots here (as this
// file used to) makes page callbacks create stub slots before the real
// library arrives, and the real GPT then throws on those foreign objects
// ("enableSingleRequest is not a function", ...) — breaking ad-supported
// sites while doing nothing for the game SDK spoofs above.
window.adsbygoogle=window.adsbygoogle||[]
window.googletag=window.googletag||{};window.googletag.cmd=window.googletag.cmd||[]
})()
