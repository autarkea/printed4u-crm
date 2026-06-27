require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Health check endpoint (без проверки секрета)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================== ЗАЩИТА ЭНДПОИНТОВ ==================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function requireSecret(req, res, next) {
    const secret = req.query?.secret || req.body?.secret;
    if (!WEBHOOK_SECRET) {
        console.log('⚠️ WEBHOOK_SECRET не установлен — пропускаем проверку');
        return next();
    }
    if (!secret || secret !== WEBHOOK_SECRET) {
        console.log(`❌ Попытка доступа без секретного ключа: ${req.path}`);
        return res.status(403).send('❌ Доступ запрещён: неверный секретный ключ');
    }
    next();
}



const PORT = 3001;
const NOCO_URL = 'http://localhost:8081/api/v1/db/data/sql';
const NOCO_TOKEN = process.env.NOCO_TOKEN;
const BASE_ID = process.env.BASE_ID;
const TABLE_PROJECTS = process.env.TABLE_PROJECTS;
const TABLE_CONTACTS = process.env.TABLE_CONTACTS;
const TABLE_LEGAL_ENTITIES = process.env.TABLE_LEGAL_ENTITIES;
const PROJECTS_ROOT = '/mnt/data/projects';
const CLIENTS_ROOT = '/mnt/data/clients';

// ================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==================

// Умная очистка имени: только запрещённые в Windows символы
function sanitize(name) {
    return String(name || 'Без имени')
        .replace(/[\/\\:*?<>|@"']/g, '')
        .trim();
}

// Генерация Client ID: 3 заглавные буквы + 3 цифры (например: ABC123)
function generateClientId() {
    const letters = Array.from({ length: 3 }, () =>
        String.fromCharCode(65 + crypto.randomInt(26))
    ).join('');
    const digits = crypto.randomInt(1000).toString().padStart(3, '0');
    return `${letters}${digits}`;
}


// Обработка имени контакта: превращаем @username в (username)
function formatContactName(name) {
    if (!name) return 'Без клиента';
    return name.replace(/@(\w+)/g, '($1)');
}

// Рекурсивный список файлов
function listFiles(dir, prefix = '') {
    let result = '';
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            result += `${prefix}- ${item.name}${item.isDirectory() ? '/' : ''}\n`;
            if (item.isDirectory()) {
                result += listFiles(path.join(dir, item.name), prefix + '  ');
            }
        }
    } catch (e) {
        result += `${prefix}[Ошибка чтения]\n`;
    }
    return result;
}

// Универсальный экстрактор имени из связанных полей NocoDB
function getLinkedName(fieldData, fallback = '') {
    if (!fieldData) return fallback;
    let record = null;
    if (Array.isArray(fieldData) && fieldData.length > 0) {
        record = fieldData[0];
    } else if (typeof fieldData === 'object' && fieldData !== null) {
        record = fieldData;
    } else if (typeof fieldData === 'string') {
        return fieldData;
    }
    if (record) {
        return record['Название'] || record['Имя'] || record['Юрлицо'] || record['Title'] || record['Name'] || fallback;
    }
    return fallback;
}

// Получаем данные проекта и формируем путь к папке
async function getProjectFolderPath(projectId) {
    const projectRes = await axios.get(`${NOCO_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
        headers: { 'xc-token': NOCO_TOKEN }
    });
    const project = projectRes.data;

    // Контакт
    let contactName = 'Без клиента';
    let contactId = null;
    if (project['Контакт']) {
        if (typeof project['Контакт'] === 'object' && !Array.isArray(project['Контакт']) && project['Контакт']['Имя']) {
            contactName = project['Контакт']['Имя'];
            contactId = project['Контакт']['Id'];
        } else if (Array.isArray(project['Контакт']) && project['Контакт'].length > 0) {
            contactName = project['Контакт'][0]['Имя'] || 'Без имени';
            contactId = project['Контакт'][0]['Id'];
        }
    }
    contactName = formatContactName(contactName);

    // Юрлицо
    let legalEntityName = '';
    let legalEntityId = null;
    if (project['Юрлицо']) {
        if (typeof project['Юрлицо'] === 'object' && !Array.isArray(project['Юрлицо']) && project['Юрлицо']['Имя']) {
            legalEntityName = project['Юрлицо']['Имя'];
            legalEntityId = project['Юрлицо']['Id'];
        } else if (Array.isArray(project['Юрлицо']) && project['Юрлицо'].length > 0) {
            legalEntityName = project['Юрлицо'][0]['Имя'] || '';
            legalEntityId = project['Юрлицо'][0]['Id'];
        }
    }

    // Получаем или генерируем Client ID
    let clientId = null;
    let clientTableId = null;
    let clientRecordId = null;
    
    if (legalEntityId) {
        // Если есть юрлицо — используем его Client ID
        clientTableId = TABLE_LEGAL_ENTITIES;
        clientRecordId = legalEntityId;
    } else if (contactId) {
        // Иначе — Client ID контакта
        clientTableId = TABLE_CONTACTS;
        clientRecordId = contactId;
    }
    
    if (clientTableId && clientRecordId) {
        try {
            const clientRes = await axios.get(`${NOCO_URL}/${BASE_ID}/${clientTableId}/${clientRecordId}`, {
                headers: { 'xc-token': NOCO_TOKEN }
            });
            clientId = clientRes.data['Client ID'];
            
            // Если Client ID нет — генерируем и сохраняем
            if (!clientId) {
                clientId = generateClientId();
                await axios.patch(`${NOCO_URL}/${BASE_ID}/${clientTableId}/${clientRecordId}`, {
                    'Client ID': clientId
                }, { headers: { 'xc-token': NOCO_TOKEN } });
                console.log(`🆕 Сгенерирован Client ID: ${clientId}`);
            }
        } catch (err) {
            console.error(`❌ Ошибка получения Client ID: ${err.message}`);
        }
    }

    // Формируем имя папки
    const projName = project['Что делаем?'] || `Проект_${projectId}`;
    let folderName = `${projectId} - ${sanitize(projName)} - ${sanitize(contactName)}`;
    if (legalEntityName) {
        folderName += ` - ${sanitize(legalEntityName)}`;
    }

    return {
        project,
        projName,
        contactName,
        legalEntityName,
        clientId,
        folderPath: path.join(PROJECTS_ROOT, folderName)
    };
}



// Создание папки клиента и symlink на папку проекта
function createClientFolderAndSymlink(clientId, clientName, projectId, projName, projectFolderPath) {
    if (!clientId) {
        console.log('⚠️ Client ID не указан, пропускаем создание папки клиента');
        return;
    }

    // Ищем существующую папку клиента по имени (игнорируем ID из NocoDB)
    const existingFolders = fs.existsSync(CLIENTS_ROOT) ? fs.readdirSync(CLIENTS_ROOT) : [];
    const matchingFolder = existingFolders.find(f => {
        const match = f.match(/^(.+)\s+\(([A-Z0-9]{6})\)$/);
        return match && match[1] === sanitize(clientName);
    });

    let clientFolderPath;
    let actualClientId = clientId;

    if (matchingFolder) {
        // Нашли существующую папку — используем её ID (защита от изменения в NocoDB)
        const match = matchingFolder.match(/\(([A-Z0-9]{6})\)$/);
        if (match) {
            actualClientId = match[1];
            if (actualClientId !== clientId) {
                console.log(`🔒 Client ID в NocoDB изменён (${clientId} → ${actualClientId}), используем ID из папки`);
            }
        }
        clientFolderPath = path.join(CLIENTS_ROOT, matchingFolder);
        console.log(`ℹ️ Используем существующую папку клиента: ${clientFolderPath}`);
    } else {
        // Создаём новую папку
        const clientFolderName = `${sanitize(clientName)} (${clientId})`;
        clientFolderPath = path.join(CLIENTS_ROOT, clientFolderName);
        fs.mkdirSync(clientFolderPath, { recursive: true });
        fs.chmodSync(clientFolderPath, 0o775);
        console.log(`📁 Создана папка клиента: ${clientFolderPath}`);
    }

    // Создаём symlink на папку проекта
    const symlinkName = `${projectId} - ${sanitize(projName)}`;
    const symlinkPath = path.join(clientFolderPath, symlinkName);

    if (!fs.existsSync(symlinkPath)) {
        try {
            fs.symlinkSync(projectFolderPath, symlinkPath, 'dir');
            console.log(`🔗 Создан symlink: ${symlinkPath} → ${projectFolderPath}`);
        } catch (err) {
            console.error(`❌ Ошибка создания symlink: ${err.message}`);
        }
    } else {
        console.log(`ℹ️ Symlink уже существует: ${symlinkPath}`);
    }
}

// ================== РОУТ: СОЗДАТЬ ПАПКУ ==================

// Создаём symlinks для всех PDF этого проекта
function createPDFSymlinks(projectId, projectFolder) {
    const pdfDir = '/mnt/data/noco-static/pdfs';
    const docsFolder = path.join(projectFolder, 'Документы');
    
    if (!fs.existsSync(docsFolder)) {
        fs.mkdirSync(docsFolder, { recursive: true });
    }
    
    if (!fs.existsSync(pdfDir)) return;
    
    const pdfs = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));
    let created = 0;
    
    for (const pdf of pdfs) {
        // Имя файла: schet_260626-6.pdf → извлекаем ID документа
        const match = pdf.match(/_(\d+)(?:_notsigned)?\.pdf$/);
        if (!match) continue;
        
        const docId = parseInt(match[1]);
        
        // Проверяем, принадлежит ли этот PDF этому проекту
        // (нужно запросить NocoDB, но для простоты — создаём symlink для всех PDF)
        const symlinkPath = path.join(docsFolder, pdf);
        const sourcePath = path.join(pdfDir, pdf);
        
        if (!fs.existsSync(symlinkPath)) {
            try {
                fs.symlinkSync(sourcePath, symlinkPath);
                console.log(`🔗 Создан symlink: ${symlinkPath} → ${sourcePath}`);
                created++;
            } catch (e) {
                console.error(`❌ Ошибка создания symlink: ${e.message}`);
            }
        }
    }
    
    return created;
}

app.all('/create-folder', requireSecret, async (req, res) => {
    try {
        const projectId = req.query.docId || req.body.Id || req.body.id || req.body.rowId || req.body.recordId;
        console.log('📦 Получен запрос. ID:', projectId, 'Method:', req.method, 'Query:', req.query, 'Body:', req.body);

        if (!projectId) {
            return res.status(400).send(getErrorHTML('Id проекта не найден. Используйте ?docId=123 в URL'));
        }

        console.log(`📂 Обработка проекта ID: ${projectId}`);

        const { project, projName, contactName, legalEntityName, clientId, folderPath } = await getProjectFolderPath(projectId);

        let isNewFolder = false;
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
            fs.chmodSync(folderPath, 0o775);
            fs.mkdirSync(path.join(folderPath, 'Исходники'), { recursive: true });
            fs.chmodSync(path.join(folderPath, 'Исходники'), 0o775);
            fs.mkdirSync(path.join(folderPath, 'Макеты'), { recursive: true });
            fs.chmodSync(path.join(folderPath, 'Макеты'), 0o775);
            fs.mkdirSync(path.join(folderPath, 'Документы'), { recursive: true });
            fs.chmodSync(path.join(folderPath, 'Документы'), 0o775);
            console.log(`✅ Создана папка: ${folderPath}`);
            isNewFolder = true;
        } else {
            console.log(`ℹ️ Папка уже существует: ${folderPath}`);
        }

        // Создаём папку клиента и symlink на папку проекта
        const clientName = legalEntityName || contactName;
        createClientFolderAndSymlink(clientId, clientName, projectId, projName, folderPath);

        // Обновляем поле "Файлы в папке"
        const fileList = listFiles(folderPath);
        const fieldText = `📁 Путь: ${folderPath}\n\n📄 Содержимое:\n${fileList}`;

        await axios.patch(`${NOCO_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
            'Файлы в папке': fieldText
        }, { headers: { 'xc-token': NOCO_TOKEN } });

        console.log(`✅ Поле "Файлы в папке" обновлено для проекта #${projectId}`);

        if (req.method === 'GET') {
            res.send(getSuccessHTML(projectId, projName, contactName, legalEntityName, folderPath, isNewFolder));
        } else {
            res.json({
                success: true,
                message: isNewFolder ? 'Папка создана и поле обновлено' : 'Папка уже существует, поле обновлено',
                path: folderPath,
                isNew: isNewFolder
            });
        }

    } catch (error) {
        console.error('❌ Ошибка вебхука:', error.message);
        if (error.response) console.error('Ответ NocoDB:', error.response.data);
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== РОУТ: ОБНОВИТЬ СПИСОК ФАЙЛОВ ==================
app.all('/refresh-files', requireSecret, async (req, res) => {
    try {
        const projectId = req.query.docId || req.body.Id || req.body.id;
        console.log('🔄 Обновление файлов для проекта ID:', projectId);

        if (!projectId) {
            return res.status(400).send(getErrorHTML('Id проекта не найден. Используйте ?docId=123 в URL'));
        }

        const { projName, contactName, legalEntityName, folderPath } = await getProjectFolderPath(projectId);

        if (!fs.existsSync(folderPath)) {
            return res.status(404).send(getErrorHTML(`Папка не найдена: ${folderPath}. Сначала создайте папку.`));
        }

        // Формируем список файлов
        const fileList = listFiles(folderPath);
        const fieldText = `📁 Путь: ${folderPath}\n\n📄 Содержимое:\n${fileList}`;

        // Обновляем поле в NocoDB
        await axios.patch(`${NOCO_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
            'Файлы в папке': fieldText
        }, { headers: { 'xc-token': NOCO_TOKEN } });

        console.log(`✅ Поле "Файлы в папке" обновлено для проекта #${projectId}`);

        if (req.method === 'GET') {
            res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Файлы обновлены ✅</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}
.container {
    background: white;
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    padding: 40px;
    max-width: 700px;
    width: 100%;
    text-align: center;
    animation: slideIn 0.5s ease-out;
}
@keyframes slideIn {
    from { opacity: 0; transform: translateY(-30px); }
    to { opacity: 1; transform: translateY(0); }
}
.icon { font-size: 80px; margin-bottom: 20px; animation: bounce 1s ease-in-out; }
@keyframes bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-20px); }
}
h1 { color: #11998e; font-size: 32px; margin-bottom: 10px; }
.subtitle { color: #7f8c8d; font-size: 16px; margin-bottom: 30px; }
.info-box {
    background: #f8f9fa;
    border-left: 4px solid #11998e;
    padding: 20px;
    border-radius: 8px;
    margin: 20px 0;
    text-align: left;
}
.info-box h3 {
    color: #2c3e50;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 10px;
}
pre {
    background: #2c3e50;
    color: #ecf0f1;
    padding: 15px;
    border-radius: 8px;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
}
.btn {
    display: inline-block;
    background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
    color: white;
    text-decoration: none;
    padding: 15px 40px;
    border-radius: 50px;
    font-size: 16px;
    font-weight: 600;
    margin-top: 20px;
    transition: transform 0.2s;
}
.btn:hover { transform: translateY(-2px); }
.auto-close { color: #95a5a6; font-size: 13px; margin-top: 15px; }
</style></head>
<body>
<div class="container">
    <div class="icon">🔄</div>
    <h1>Список файлов обновлён!</h1>
    <p class="subtitle">Актуальное содержимое папки проекта</p>
    
    <div class="info-box">
        <h3>📋 Проект</h3>
        <p><strong>${sanitize(projName)}</strong></p>
    </div>
    
    <div class="info-box">
        <h3>👤 Клиент</h3>
        <p>${sanitize(contactName)}${legalEntityName ? ` (${sanitize(legalEntityName)})` : ''}</p>
    </div>
    
    <div class="info-box">
        <h3>📂 Содержимое папки</h3>
        <pre>${fieldText}</pre>
    </div>
    
    <a href="${process.env.NOCO_URL || 'http://localhost:8081'}" class="btn">← Вернуться в NocoDB</a>
    <p class="auto-close">Эта вкладка закроется автоматически через 5 секунд...</p>
</div>
<script>setTimeout(() => window.close(), 5000);</script>
</body></html>`);
        } else {
            res.json({ success: true, message: 'Список файлов обновлён' });
        }

    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== HTML СТРАНИЦЫ ==================

function getSuccessHTML(projectId, projName, contactName, legalEntityName, folderPath, isNewFolder) {
    const title = isNewFolder ? 'Папка успешно создана!' : 'Папка уже существует';
    const icon = isNewFolder ? '📁' : 'ℹ️';
    const subtitle = isNewFolder ? 'Проект подготовлен к работе' : 'Папка уже была создана ранее';
    const iconColor = isNewFolder ? '#2ecc71' : '#3498db';

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 600px;
            width: 100%;
            text-align: center;
            animation: slideIn 0.5s ease-out;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .icon {
            font-size: 80px;
            margin-bottom: 20px;
            animation: bounce 1s ease-in-out;
        }
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }
        h1 {
            color: ${iconColor};
            font-size: 32px;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #7f8c8d;
            font-size: 16px;
            margin-bottom: 30px;
        }
        .info-box {
            background: #f8f9fa;
            border-left: 4px solid #667eea;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            text-align: left;
        }
        .info-box h3 {
            color: #2c3e50;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        .info-box p {
            color: #34495e;
            font-size: 15px;
            line-height: 1.6;
            word-break: break-all;
        }
        .info-box code {
            background: #e9ecef;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
        }
        .folders {
            display: flex;
            justify-content: space-around;
            margin: 20px 0;
            flex-wrap: wrap;
            gap: 10px;
        }
        .folder-item {
            background: #667eea;
            color: white;
            padding: 10px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
        }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            padding: 15px 40px;
            border-radius: 50px;
            font-size: 16px;
            font-weight: 600;
            margin-top: 20px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        .auto-close { color: #95a5a6; font-size: 13px; margin-top: 15px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">${icon}</div>
        <h1>${title}</h1>
        <p class="subtitle">${subtitle}</p>
        
        <div class="info-box">
            <h3>📋 Название проекта</h3>
            <p><strong>${sanitize(projName)}</strong></p>
        </div>
        
        <div class="info-box">
            <h3>👤 Клиент</h3>
            <p>${sanitize(contactName)}${legalEntityName ? ` (${sanitize(legalEntityName)})` : ''}</p>
        </div>
        
        <div class="info-box">
            <h3>📂 Путь к папке</h3>
            <p><code>${folderPath}</code></p>
        </div>
        
        <div class="folders">
            <div class="folder-item">📄 Исходники</div>
            <div class="folder-item">🎨 Макеты</div>
            <div class="folder-item">📑 Документы</div>
        </div>
        
        <a href="${process.env.NOCO_URL || 'http://localhost:8081'}" class="btn">← Вернуться в NocoDB</a>
        <p class="auto-close">Эта вкладка закроется автоматически через 5 секунд...</p>
    </div>
    <script>
        setTimeout(() => { window.close(); }, 5000);
    </script>
</body>
</html>`;
}

function getErrorHTML(errorMessage) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Ошибка ❌</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 600px;
            width: 100%;
            text-align: center;
        }
        .icon { font-size: 80px; margin-bottom: 20px; }
        h1 { color: #e74c3c; font-size: 32px; margin-bottom: 10px; }
        .subtitle { color: #7f8c8d; font-size: 16px; margin-bottom: 30px; }
        .error-box {
            background: #fee;
            border-left: 4px solid #e74c3c;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            text-align: left;
        }
        .error-box h3 {
            color: #c0392b;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        .error-box p {
            color: #34495e;
            font-size: 14px;
            line-height: 1.6;
            word-break: break-all;
            font-family: 'Courier New', monospace;
        }
        .btn {
            display: inline-block;
            background: #e74c3c;
            color: white;
            text-decoration: none;
            padding: 15px 40px;
            border-radius: 50px;
            font-size: 16px;
            font-weight: 600;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">❌</div>
        <h1>Ошибка</h1>
        <p class="subtitle">Не удалось выполнить операцию</p>
        <div class="error-box">
            <h3>🔍 Детали ошибки</h3>
            <p>${errorMessage}</p>
        </div>
        <a href="${process.env.NOCO_URL || 'http://localhost:8081'}" class="btn">← Вернуться в NocoDB</a>
    </div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`🚀 Вебхук-сервер запущен на порту ${PORT}`);
});
