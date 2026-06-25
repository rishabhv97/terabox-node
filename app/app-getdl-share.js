#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { request } from 'undici';
import { input } from '@inquirer/prompts';

import { Readable } from 'node:stream';

import Argv from './module-argv.js';
import TeraBoxApp from 'terabox-api';

import {
    loadYaml, selectAccount,
} from './module-helper.js';

// init app
let app = {};
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadYaml(path.resolve(__dirname, './.config.yaml'));
const meta = loadYaml(path.resolve(__dirname, '../package.json'));

console.log(`[INFO] ${meta.name_ext} v${meta.version} (GetShareDL Module)`);

const yargs = new Argv(config, ['a','s','r']);
yargs.addArgv({
    'showurl': {
        describe: 'show download urls',
        type: 'boolean',
    },
});

if(yargs.getArgv('help')){
    yargs.showHelp();
    process.exit();
}

let rootPath = '';
const reqPath = yargs.getArgv('r') || '';

(async () => {
    try{
        if(!config.accounts){
            console.error('[ERROR] Accounts not set!');
            return;
        }
        
        let cur_acc;
        if(yargs.getArgv('a')){
            cur_acc = config.accounts[yargs.getArgv('a')];
        }
        else{
            cur_acc = await selectAccount(config);
        }
        
        app = new TeraBoxApp(cur_acc);
        
        const acc_check = await app.checkLogin();
        if(acc_check.errno != 0){
            console.error('[ERROR] "ndus" cookie is BAD!');
            return;
        }
        
        await getShareDL(yargs.getArgv('s'));
    }
    catch(error){
        console.error(error);
    }
})();

async function getShareDL(argv_surl){
    const tbUrl = argv_surl ? argv_surl : await input({ message: 'Share URL/SURL:' });
    const regexRUrl = /^\/s\/1([A-Za-z0-9_-]+)$/;
    const regexSUrl = /^[A-Za-z0-9_-]+$/;
    let shareUrl = '';
    
    if(tbUrl.match(regexSUrl)){
        shareUrl = tbUrl;
    }
    if(shareUrl == ''){
        try{
            const sUrl = new URL(tbUrl);
            const sUrlSP = sUrl.searchParams.get('surl');
            if(sUrl.pathname.match(regexRUrl)){
                shareUrl = sUrl.pathname.match(regexRUrl)[1];
            }
            if(sUrl.pathname == '/sharing/link' && typeof sUrlSP == 'string' && sUrlSP.match(regexSUrl)){
                shareUrl = sUrlSP;
            }
            if(shareUrl == ''){
                throw new Error();
            }
        }
        catch(error){
            console.error(':: BAD URL', tbUrl);
        }
    }
    if(shareUrl == ''){
        await getShareDL();
        return;
    }
    
    const shareInfo = await app.shortUrlInfo(shareUrl);
    
    let sFsList = [];
    if(shareInfo.errno == 0){
        if(shareInfo.fcount > 0){
            sFsList = await getRemotePath(shareUrl, reqPath);
        }
    }
    else{
        const errorText = shareInfo.show_msg != '' ? shareInfo.show_msg : 'BAD Share URL';
        console.error(`[ERROR] Error #${shareInfo.errno}. ${shareInfo.show_msg}.`);
        return;
    }
    
    if(sFsList.length > 0){
        const fsList = [];
        for(const f of sFsList){
            const fsData = {
                path: f.path,
                filename: f.server_filename,
                dlink: f.dlink.replace(/&chkv=0&chkbd=0&chkpc=&dp-logid=(\d+)&dp-callid=0&r=(\d+)&sh=1/, '') + '&origin=dlna',
            };
            if(yargs.getArgv('showurl')){
                console.log('::','addedURL:', fsData.dlink);
            }
            fsList.push(fsData);
        }
        await addDownloads(fsList);
        return;
    }
    
    console.log('[INFO] No files in shared folder!');
};

async function getRemotePath(shareUrl, remoteDir){
    const shareReq = await app.shortUrlList(shareUrl, remoteDir);
    if(shareReq.errno == 0){
        remoteDir = stripPath(remoteDir || '', 'root');
        if(shareReq.title && shareReq.list.length > 1){
            remoteDir = `init/${shareReq.list.length} Files`;
        }
        if(shareReq.title && shareReq.list.length == 1){
            shareReq.title = shareReq.title.split('/').at(-1);
            remoteDir = `init/${shareReq.title}`;
        }
        console.log(':: Got Share:', shareUrl, remoteDir);
        
        const fileList = [];
        for(const f of shareReq.list){
            if(shareReq.title){
                rootPath = f.path.split('/').slice(0, -1).join('/');
            }
            if(f.isdir == '1'){
                const subList = await getRemotePath(shareUrl, f.path);
                fileList.push(...subList);
            }
            else{
                f.path = changeRoot(stripPath(f.path.split('/').slice(0, -1).join('/')));
                console.log('[INFO] addedFile:', 'root/' + (f.path?f.path+'/':'') + f.server_filename);
                fileList.push(f);
            }
        }
        return fileList;
    }
    else{
        return [];
    }
}

function stripPath(rPath, rootDir){
    return (rootDir ? `${rootDir}/` : '') + rPath.replace(rootPath, '').replace(new RegExp('^/'), '');
}

function changeRoot(rPath){
    const newRootDir = reqPath.replace(/\/+/g, '/').replace(new RegExp('^/'), '').replace(new RegExp('/$'), '');
    return rPath.replace(new RegExp('^' + newRootDir), '').replace(new RegExp('^/'), '');
}

async function addDownloads(fsList) {
    // Add your exact ndus cookie here
    const myCookie = "ndus=YQGViBNpeHui1Q4wYb37PL51qXZC3YEwZu4ULbUg";

    for (const f of fsList) {
        console.log(`\n:: Starting direct download for: ${f.filename}`);
        console.log(`:: Please wait, downloading directly via Node.js...`);

        try {
            // 1. Use native fetch, which automatically follows 302 redirects!
            const res = await fetch(f.dlink, {
                method: 'GET',
                headers: {
                    'User-Agent': app.params.ua,
                    'Cookie': myCookie
                }
            });

            if (!res.ok) {
                console.log(`[ERROR] Download failed! Status code: ${res.status}`);
                continue;
            }

            // 2. Stream the response body directly to a local file
            const dest = fs.createWriteStream(f.filename);
            Readable.fromWeb(res.body).pipe(dest);

            await new Promise((resolve, reject) => {
                dest.on('finish', resolve);
                dest.on('error', reject);
            });

            console.log(`[SUCCESS] File saved locally as: ${f.filename}\n`);
        } catch (err) {
            console.error(`[ERROR] Failed to download ${f.filename}:`, err.message);
        }
    }
}