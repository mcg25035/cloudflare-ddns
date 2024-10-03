
require('dotenv').config();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const { CLOUDFLARE_API_TOKEN, CHECK_INTERVAL = 300, PORT = 3000 } = process.env;
const DOMAINS_FILE = 'domains.json';
const IP_FILE = 'last_ip.txt';

const getTimestamp = () => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
};

const log = (...args) => {
    console.log(`[${getTimestamp()}]`, ...args);
};

const errorLog = (...args) => {
    console.error(`[${getTimestamp()}]`, ...args);
};

let domains = [];
if (fs.existsSync(DOMAINS_FILE)) {
    try {
        domains = JSON.parse(fs.readFileSync(DOMAINS_FILE));
    } 
    catch (err) {
        errorLog('讀取 domains.json 失敗:', err.message);
        domains = [];
    }
} 
else {
    fs.writeFileSync(DOMAINS_FILE, JSON.stringify(domains, null, 2));
}

const saveDomains = () => fs.writeFileSync(DOMAINS_FILE, JSON.stringify(domains, null, 2));

const getLastIP = () => {
    if (fs.existsSync(IP_FILE)) {
        try {
            return fs.readFileSync(IP_FILE, 'utf-8').trim();
        } 
        catch (err) {
            errorLog('讀取 last_ip.txt 失敗:', err.message);
            return null;
        }
    }
    return null;
};

const saveLastIP = (ip) => {
    fs.writeFileSync(IP_FILE, ip);
};

const getPublicIP = async () => {
    try {
        const { data: { ip } } = await axios.get('https://api.ipify.org?format=json');
        return ip;
    } 
    catch (error) {
        errorLog('獲取公共 IP 失敗:', error.message);
        return null;
    }
};

const getZoneID = async (zone) => {
    try {
        const { data } = await axios.get(`https://api.cloudflare.com/client/v4/zones?name=${zone}`, {
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        if (data.success && data.result.length) return data.result[0].id;
        errorLog(`找不到 Zone ID for zone: ${zone}`);
        return null;
    } catch (error) {
        errorLog(`獲取 Zone ID 失敗 for zone ${zone}:`, error.message);
        return null;
    }
};

const getDNSRecordID = async (zoneID, recordName) => {
    try {
        const { data } = await axios.get(`https://api.cloudflare.com/client/v4/zones/${zoneID}/dns_records`, {
            params: { type: 'A', name: recordName },
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        if (data.success && data.result.length) return data.result[0].id;
        errorLog(`找不到 DNS Record ID for ${recordName} in zone ${zoneID}`);
        return null;
    } catch (error) {
        errorLog(`獲取 DNS Record ID 失敗 for ${recordName}:`, error.message);
        return null;
    }
};

const updateDNSRecord = async (zoneID, recordID, recordName, ip) => {
    try {
        const { data } = await axios.put(`https://api.cloudflare.com/client/v4/zones/${zoneID}/dns_records/${recordID}`, {
            type: 'A',
            name: recordName,
            content: ip,
            ttl: 1,
            proxied: false
        }, {
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (data.success) {
            log(`成功更新 ${recordName} 至 IP: ${ip}`);
        } 
        else {
            errorLog(`更新 ${recordName} 失敗:`, data.errors);
        }
    } 
    catch (error) {
        errorLog(`更新 DNS Record 失敗 for ${recordName}:`, error.message);
    }
};

const updateDNS = async () => {
    const currentIP = await getPublicIP();
    if (!currentIP) return;

    const lastIP = getLastIP();
    if (currentIP === lastIP) {
        log(`IP 未更變 (${currentIP})，跳過更新。`);
        return;
    }

    log(`IP 更變: ${lastIP} -> ${currentIP}`);

    for (const { zone, record } of domains) {
        const zoneID = await getZoneID(zone);
        if (!zoneID) continue;

        const recordID = await getDNSRecordID(zoneID, record);
        if (!recordID) continue;

        await updateDNSRecord(zoneID, recordID, record, currentIP);
    }

    saveLastIP(currentIP);
};

setInterval(updateDNS, CHECK_INTERVAL * 1000);
updateDNS(); 

app.post('/domains', (req, res) => {
    const { zone, record } = req.body;
    if (!zone || !record) return res.status(400).json({ message: 'zone 和 record 是必填項。' });

    if (domains.some(d => d.zone === zone && d.record === record)) {
        return res.status(400).json({ message: '該domain已存在。' });
    }

    domains.push({ zone, record });
    saveDomains();
    log(`新增domain: zone=${zone}, record=${record}`);
    res.status(201).json({ message: 'domain已新增。', domains });
});

app.delete('/domains', (req, res) => {
    const { zone, record } = req.body;
    if (!zone || !record) return res.status(400).json({ message: 'zone 和 record 是必填項。' });

    const initialLength = domains.length;
    domains = domains.filter(d => !(d.zone === zone && d.record === record));

    if (domains.length === initialLength) {
        return res.status(404).json({ message: '找不到該domain。' });
    }

    saveDomains();
    log(`移除domain: zone=${zone}, record=${record}`);
    res.status(200).json({ message: 'domain已移除。', domains });
});

app.get('/domains', (req, res) => res.status(200).json(domains));

app.listen(PORT, () => log(`Dynamic DNS 服務正在運行，API 伺服器在port ${PORT}`));
