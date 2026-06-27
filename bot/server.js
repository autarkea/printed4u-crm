require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== ЗАЩИТА ЭНДПОИНТОВ ==================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Middleware для проверки секрета
function requireSecret(req, res, next) {
    const secret = req.query.secret || req.body.secret;
    if (!WEBHOOK_SECRET) {
        console.log('⚠️ WEBHOOK_SECRET не установлен — пропускаем проверку');
        return next();
    }
    if (secret !== WEBHOOK_SECRET) {
        console.log(`❌ Попытка доступа без секретного ключа: ${req.path}`);
        return res.status(403).send('❌ Доступ запрещён: неверный секретный ключ');
    }
    next();
}



const PORT = process.env.PORT || 3000;
const generatingDocs = new Set();
const NOCO_BASE_URL = process.env.NOCO_DOMAIN || 'http://localhost:8081';
const NOCO_API_URL = 'http://host.docker.internal:8081/api/v1/db/data/sql';
const NOCO_API_TOKEN = process.env.NOCO_TOKEN;
const BASE_ID = process.env.BASE_ID;

const TABLE_DOCS = process.env.TABLE_DOCUMENTS;
const TABLE_TASKS = process.env.TABLE_TASKS;
const TABLE_PROJECTS = process.env.TABLE_PROJECTS;
const TABLE_ITEMS = process.env.TABLE_ITEMS;

const PDF_DIR = '/mnt/data/noco-static/pdfs';
const PROJECTS_ROOT = '/mnt/data/projects';
const DOC_TYPE_MAP = { 'Счет': 'schet', 'Акт': 'act', 'Накладная': 'nakladnaya', 'ТН': 'nakladnaya' };

// Генерация номера документа в формате ГГММДД-ID
function generateDocNumber(dateStr, id) {
    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    return `${year}${month}${day}-${id}`;
}

// ================== SMTP НАСТРОЙКИ ==================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// ================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==================

function extractId(field) {
    if (Array.isArray(field)) return field[0]?.Id || field[0];
    if (typeof field === 'object' && field !== null) return field.Id;
    return field;
}

function extractProjectId(projectField) {
    return extractId(projectField);
}

function findProjectFolder(projectId) {
    if (!fs.existsSync(PROJECTS_ROOT)) return null;
    const projects = fs.readdirSync(PROJECTS_ROOT);
    const match = projects.find(p => p.startsWith(`${projectId} -`));
    return match ? path.join(PROJECTS_ROOT, match) : null;
}

function listFilesRecursive(dir, prefix = '') {
    let result = '';
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.name.startsWith('.')) continue;
            result += `${prefix}- ${item.name}${item.isDirectory() ? '/' : ''}\n`;
            if (item.isDirectory()) {
                result += listFilesRecursive(path.join(dir, item.name), prefix + '  ');
            }
        }
    } catch (e) {
        result += `${prefix}[Ошибка чтения]\n`;
    }
    return result;
}

function parseResponsible(text) {
    if (!text) return { phone: '+375 29 537 47 47', name: 'Александр' };
    const match = text.match(/^([\d\s+()-]+)\s+(.+)$/);
    if (match) {
        return {
            phone: match[1].trim(),
            name: match[2].trim()
        };
    }
    return { phone: text, name: '' };
}

async function calculateProjectTotal(projectId) {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_ITEMS}?limit=1000`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        const items = response.data.list || [];
        
        let total = 0;
        for (const item of items) {
            const itemProjectId = extractId(item['Проекты']);
            if (itemProjectId == projectId) {
                total += parseFloat(item['Сумма'] || 0);
            }
        }
        
        return total;
    } catch (error) {
        console.error('Ошибка подсчёта суммы:', error.message);
        return 0;
    }
}

function getDocTypeName(type) {
    const map = {
        'Счет': 'счёт-договор',
        'Акт': 'акт выполненных работ',
        'Накладная': 'товарную накладную',
        'ТН': 'товарную накладную'
    };
    return map[type] || 'документ';
}

// Поиск пути к PDF файлу
function findPDFPath(pdfFileName, projectId) {
    // Сначала проверяем в PDF_DIR (symlink)
    let pdfPath = path.join(PDF_DIR, pdfFileName);
    if (fs.existsSync(pdfPath)) return pdfPath;
    
    // Если нет - ищем в папке проекта
    if (projectId) {
        const projectFolder = findProjectFolder(projectId);
        if (projectFolder) {
            const docsPath = path.join(projectFolder, 'Документы', pdfFileName);
            if (fs.existsSync(docsPath)) return docsPath;
        }
    }
    
    return null;
}

// ================== ОТПРАВКА EMAIL ==================

async function sendEmailWithPDF({ toEmail, subject, text, html, pdfPath, pdfFileName }) {
    console.log(`📧 Отправка email на ${toEmail}...`);
    
    const mailOptions = {
        from: `"CRM" <${process.env.SMTP_FROM}>`,
        to: toEmail,
        subject: subject,
        text: text,
        html: html,
        attachments: [
            {
                filename: pdfFileName,
                path: pdfPath
            }
        ]
    };
    
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email отправлен: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error(`❌ Ошибка отправки email:`, error.message);
        throw error;
    }
}

// ================== PDF ГЕНЕРАЦИЯ ==================
async function generatePDF(docId) {
    console.log(`\n🚀 Генерация PDF для ID=${docId}`);

    // Простая блокировка: если уже генерируется — просто выходим
    if (generatingDocs.has(docId)) {
        console.log(`⏳ ID=${docId} уже генерируется. Возвращаем существующий файл.`);
        // Получаем данные, чтобы найти файл
        const tempDoc = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        }).then(r => r.data).catch(() => null);
        
        if (tempDoc) {
            const tempType = tempDoc['Тип документа'];
            const tempHtml = DOC_TYPE_MAP[tempType];
            if (tempHtml) {
                const tempNumber = generateDocNumber(tempDoc['Дата документа'], docId);
                const tempWithStamp = tempDoc['С печатью'] === true || tempDoc['С печатью'] === 1;
                const tempSuffix = tempWithStamp ? '' : '_notsigned';
                const tempFileName = `${tempHtml}_${tempNumber}${tempSuffix}.pdf`;
                const tempProjectId = extractProjectId(tempDoc['Проект']);
                const existingPath = findPDFPath(tempFileName, tempProjectId);
                if (existingPath) {
                    const stats = fs.statSync(existingPath);
                    console.log(`✅ Найден существующий файл: ${tempFileName}`);
                    return { fileName: tempFileName, url: `${NOCO_BASE_URL}/pdfs/${tempFileName}`, size: stats.size, skipped: false, pdfPath: existingPath };
                }
            }
        }
        // Если файл не найден — возвращаем ошибку
        return { error: 'Документ сейчас генерируется, попробуйте через минуту' };
    }
    generatingDocs.add(docId);

    
    // Защита от повторной генерации: проверяем, что файл уже существует и создан менее 1 минуты назад
    try {
        console.log(`📋 Шаг 1: Получение данных документа ID=${docId}`);
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        const doc = docRes.data;
        console.log(`✅ Документ получен. Тип: ${doc['Тип документа']}`);
        
        const docType = doc['Тип документа'];
        const htmlFile = DOC_TYPE_MAP[docType];
        if (!htmlFile) throw new Error(`Неизвестный тип документа: ${docType}`);
        console.log(`✅ HTML файл: ${htmlFile}`);
        
        const docNumber = generateDocNumber(doc['Дата документа'], docId);
        const withStamp = doc['С печатью'] === true || doc['С печатью'] === 1 || doc['С печатью'] === 'true' || doc['С печатью'] === '1';
        const suffix = withStamp ? '' : '_notsigned';
        const pdfFileName = `${htmlFile}_${docNumber}${suffix}.pdf`;
        const projectId = extractProjectId(doc['Проект']);
        
        // Проверяем, есть ли уже свежий файл
        const existingPath = findPDFPath(pdfFileName, projectId);
        if (existingPath) {
            const stats = fs.statSync(existingPath);
            const ageMinutes = (Date.now() - stats.mtimeMs) / 60000;
            if (ageMinutes < 1) {
                console.log(`✅ Файл уже существует и создан ${ageMinutes.toFixed(1)} мин назад. Используем существующий.`);
                return { fileName: pdfFileName, url: `${NOCO_BASE_URL}/pdfs/${pdfFileName}`, size: stats.size, skipped: false, pdfPath: existingPath };
            }
        }
    } catch (e) {
        console.log(`⚠️ Не удалось проверить существующий файл: ${e.message}`);
    }
    let docData;
    try {
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, { headers: { 'xc-token': NOCO_API_TOKEN } });
        docData = docRes.data;
    } catch (err) { throw new Error(`Ошибка NocoDB: ${err.message}`); }

    const docType = docData['Тип документа'];
    const htmlFile = DOC_TYPE_MAP[docType];
    if (!htmlFile) throw new Error(`Неизвестный тип: ${docType}`);

    // Формируем имя файла: schet_260618-2.pdf или schet_260618-2_notsigned.pdf
    const docNumber = generateDocNumber(docData['Дата документа'], docId);
    const withStamp = docData['С печатью'] === true || docData['С печатью'] === 1 || docData['С печатью'] === 'true' || docData['С печатью'] === '1';
    const suffix = withStamp ? '' : '_notsigned';
    const pdfFileName = `${htmlFile}_${docNumber}${suffix}.pdf`;
    let pdfPath;
    let savedInProject = false;

    const projectId = extractProjectId(docData['Проект']);
    if (projectId) {
        const projectFolder = findProjectFolder(projectId);
        if (projectFolder) {
            const docsFolder = path.join(projectFolder, 'Документы');
            if (!fs.existsSync(docsFolder)) {
                fs.mkdirSync(docsFolder, { recursive: true });
            }
            pdfPath = path.join(docsFolder, pdfFileName);
            console.log(`📂 Сохраняем PDF в папку проекта: ${pdfPath}`);
            savedInProject = true;

            const symlinkPath = path.join(PDF_DIR, pdfFileName);
            
            // Удаляем старый файл/symlink (включая битые symlinks!)
            try {
                if (fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath).isSymbolicLink()) {
                    fs.rmSync(symlinkPath, { force: true });
                    console.log(`🗑️ Удалён старый файл/symlink: ${symlinkPath}`);
                }
            } catch (e) {
                // lstatSync падает, если файл не существует — это нормально
                if (e.code !== 'ENOENT') {
                    console.log(`⚠️ Проверка старого файла: ${e.message}`);
                }
            }
            
            // Создаём symlink
            try {
                fs.symlinkSync(pdfPath, symlinkPath);
                console.log(`🔗 Создан symlink: ${symlinkPath} → ${pdfPath}`);
            } catch (e) {
                if (e.code === 'EEXIST') {
                    console.log(`⚠️ Symlink уже существует: ${symlinkPath}`);
                } else {
                    console.error(`❌ Ошибка создания symlink: ${e.message}`);
                    throw e;
                }
            }
        } else {
            pdfPath = path.join(PDF_DIR, pdfFileName);
            console.log(`⚠️ Папка проекта не найдена, сохраняем в ${pdfPath}`);
        }
    } else {
        pdfPath = path.join(PDF_DIR, pdfFileName);
        console.log(`⚠️ Проект не указан, сохраняем в ${pdfPath}`);
    }

    const pdfUrl = `${NOCO_BASE_URL}/pdfs/${pdfFileName}`;
    let browser;

    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage();
        
        // Логируем ошибки из браузера
        page.on('console', msg => {
            if (msg.type() === 'error') {
                console.error(`🌐 Browser error: ${msg.text()}`);
            }
        });
        page.on('pageerror', err => {
            console.error(`🌐 Page error: ${err.message}`);
        });
        page.on('requestfailed', req => {
            console.error(`🌐 Request failed: ${req.url()} - ${req.failure().errorText}`);
        });
        await page.goto(`${NOCO_BASE_URL}/${htmlFile}.html?doc=${docId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`⏳ Ожидание загрузки данных...`);
        await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 30000 });
        console.log(`✅ Данные загружены`);
        await new Promise(r => setTimeout(r, 1000));
        console.log(`📝 Шаг 4: Генерация PDF в ${pdfPath}`);
        await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' }, printBackground: true });
        console.log(`✅ PDF создан`);
        await browser.close(); browser = null;

        const stats = fs.statSync(pdfPath);
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

        await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            'PDF ссылка': pdfUrl, 'PDF сгенерирован': true, 'Дата последнего PDF': now
        }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });

        if (projectId && savedInProject) {
            try {
                const projectFolder = findProjectFolder(projectId);
                if (projectFolder) {
                    const fileList = listFilesRecursive(projectFolder);
                    const fieldText = `📁 Путь: ${projectFolder}\n\n📄 Содержимое:\n${fileList}`;
                    
                    await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
                        'Файлы в папке': fieldText
                    }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
                    
                    console.log(`✅ Поле "Файлы в папке" обновлено для проекта #${projectId}`);
                }
            } catch (e) {
                console.log(`⚠️ Не удалось обновить поле "Файлы в папке": ${e.message}`);
            }
        }

        return { fileName: pdfFileName, url: pdfUrl, size: stats.size, skipped: false, pdfPath };
    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        throw error;
    } finally {
        // ВСЕГДА очищаем блокировку, даже при ошибке
        generatingDocs.delete(docId);
        console.log(`🔓 Блокировка снята для ID=${docId}`);
    }
}

// ================== ЛОГИКА ДЛЯ ЗАДАЧ ==================
async function updateTask(taskId) {
    console.log(`\n📋 Получена задача ID=${taskId}, запрашиваю данные из NocoDB...`);
    try {
        const res = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_TASKS}/${taskId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        const task = res.data;
        const isDone = task['Готово'];
        const hasTime = task['Когда сделали'];
        console.log(`📋 Задача ID=${taskId}, Готово=${isDone}, Когда сделали="${hasTime}"`);

        if (isDone && !hasTime) {
            const now = new Date().toLocaleString('ru-RU', {
                timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_TASKS}/${taskId}`, {
                'Когда сделали': now
            }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
            console.log(`✅ Задача ${taskId} закрыта, время: ${now}`);
        } else if (!isDone && hasTime) {
            await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_TASKS}/${taskId}`, {
                'Когда сделали': null
            }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
            console.log(`🔄 Задача ${taskId} переоткрыта, время очищено`);
        } else {
            console.log(`⏸️ Задача ${taskId} не требует обновления (защита от цикла)`);
        }
    } catch (err) {
        console.error(`❌ Ошибка обновления задачи ${taskId}:`, err.message);
    }
}

// ================== РОУТЫ ==================


// ================== ПРОКСИ-РОУТЫ ДЛЯ HTML-ШАБЛОНОВ ==================
// Безопасный доступ к NocoDB API без токена в HTML

// Получить данные документа по ID
app.get('/api/doc/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/doc/${req.params.id}:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить данные проекта по ID
app.get('/api/project/:id', async (req, res) => {
    try {
        const projectId = req.params.id;
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/project/${req.params.id}:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить все позиции (с опциональной фильтрацией по проекту)
app.get('/api/items', async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_ITEMS}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/items:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить мои реквизиты (всегда ID=1)
app.get('/api/my-details', async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_MY_DETAILS || "maob70r6njy4b31"}/1`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/my-details:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить данные юрлица по ID
app.get('/api/client/:id', async (req, res) => {
    try {
        const clientId = req.params.id;
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_LEGAL_ENTITIES || "mel0fql6jhtknu6"}/${clientId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/client/${req.params.id}:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить данные контакта по ID
app.get('/api/contact/:id', async (req, res) => {
    try {
        const contactId = req.params.id;
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS || "mh4tuppyvnapu7b"}/${contactId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/contact/${req.params.id}:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

// Получить все документы (для act.html и nakladnaya.html)
app.get('/api/docs', async (req, res) => {
    try {
        const response = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        res.json(response.data);
    } catch (err) {
        console.error(`❌ Ошибка прокси /api/docs:`, err.message);
        res.status(err.response?.status || 500).json({ error: err.message });
    }
});

app.get('/', async (req, res) => {
    const docId = parseInt(req.query.docId);
    if (!docId) return res.status(400).send('Ошибка: параметр ?docId обязателен');
    
    try {
        const result = await generatePDF(docId);
        console.log(`📊 Результат generatePDF для ID=${docId}: fileName=${result.fileName}`);
        
        res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>PDF сгенерирован ✅</title>
    <!-- Без автоперехода -->
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; margin: 0; }
        .container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; max-width: 600px; width: 100%; text-align: center; animation: slideIn 0.5s ease-out; }
        @keyframes slideIn { from { transform: translateY(-30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .icon { font-size: 80px; margin-bottom: 20px; animation: bounce 1s ease-in-out; }
        @keyframes bounce { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.2); } }
        h1 { color: #27ae60; font-size: 32px; margin-bottom: 10px; }
        .subtitle { color: #7f8c8d; font-size: 16px; margin-bottom: 30px; }
        .info-box { background: #f0fdf4; border-left: 4px solid #27ae60; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: left; }
        .info-box h3 { color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #6b7280; font-weight: 500; }
        .info-value { color: #111827; font-weight: 600; }
        .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; border-radius: 10px; text-decoration: none; font-weight: 600; margin: 10px 5px; transition: transform 0.2s; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(0,0,0,0.2); }
        .btn-secondary { background: #6b7280; }
        .countdown { margin-top: 20px; color: #7f8c8d; font-size: 14px; }
        .progress-bar { width: 100%; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden; margin-top: 15px; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); animation: progress 5s linear forwards; }
        @keyframes progress { from { width: 100%; } to { width: 0%; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>PDF успешно сгенерирован!</h1>
        <p class="subtitle">Документ готов к отправке</p>
        <div class="info-box">
            <h3>📄 Информация о документе</h3>
            <div class="info-row">
                <span class="info-label">Имя файла:</span>
                <span class="info-value">${result.fileName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Размер:</span>
                <span class="info-value">${(result.size / 1024).toFixed(1)} КБ</span>
            </div>
            <div class="info-row">
                <span class="info-label">Статус:</span>
                <span class="info-value" style="color: #27ae60;">✓ Готов к отправке</span>
            </div>
        </div>
        <a href="/send-email?docId=${docId}" class="btn">📧 Отправить по email</a>
        <a href="${result.url}" target="_blank" class="btn btn-secondary">👁 Открыть PDF</a>
        <div class="countdown">
            Автопереход через <span id="timer">5</span> сек
            <div class="progress-bar"><div class="progress-fill"></div></div>
        </div>
    </div>
    <script>
        let seconds = 5;
        const timer = document.getElementById('timer');
        const interval = setInterval(() => {
            seconds--;
            if (timer) timer.textContent = seconds;
            if (seconds <= 0) { clearInterval(interval); window.location.href = '/send-email?docId=${docId}'; }
        }, 1000);
    </script>
</body>
</html>`);
    } catch (error) {
        console.error('❌ Ошибка генерации PDF:', error.message);
        res.status(500).send(`<h1>❌ Ошибка</h1><p>${error.message}</p>`);
    }
});

// ================== РОУТ: ФОРМА ОТПРАВКИ EMAIL ==================
app.get('/send-email', requireSecret, async (req, res) => {
    const docId = parseInt(req.query.docId);
    if (!docId) return res.status(400).send(getErrorHTML('Параметр ?docId обязателен'));
    
    console.log(`\n📧 Форма отправки email для документа ID=${docId}`);
    
    try {
        // 1. Получаем данные документа
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        const doc = docRes.data;
        
        const docType = doc['Тип документа'];
        const htmlFile = DOC_TYPE_MAP[docType];
        if (!htmlFile) throw new Error(`Неизвестный тип документа: ${docType}`);
        
        // Формируем базовое имя файла (без суффикса)
        const docNumber = generateDocNumber(doc['Дата документа'], docId);
        let pdfFileName = `${htmlFile}_${docNumber}.pdf`;
        const projectId = extractProjectId(doc['Проект']);
        
        
        // 3. Получаем данные проекта
        let project = null;
        if (projectId) {
            console.log(`🔍 Запрос проекта ID=${projectId}`);
            const projRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_PROJECTS}/${projectId}`, {
                headers: { 'xc-token': NOCO_API_TOKEN }
            });
            project = projRes.data;
        }
        
        // 4. Подсчитываем сумму
        const total = await calculateProjectTotal(projectId);
        
        // 5. Парсим ответственного
        const responsible = parseResponsible(doc['Ответственный']);
        // 6. Определяем email получателя
        let contactEmail = '';
        let contactName = '';
        let legalEmail = '';
        let legalName = '';
        
        if (project) {
            // Получаем ID контакта
            let contactId = null;
            if (project['Контакт']) {
                if (Array.isArray(project['Контакт']) && project['Контакт'].length > 0) {
                    contactId = project['Контакт'][0].Id || project['Контакт'][0];
                } else if (typeof project['Контакт'] === 'object' && project['Контакт'] !== null) {
                    contactId = project['Контакт'].Id;
                } else if (typeof project['Контакт'] === 'number') {
                    contactId = project['Контакт'];
                }
            }
            
            // Делаем отдельный запрос к таблице Контакты
            if (contactId) {
                try {
                    console.log(`🔍 Запрос контакта ID=${contactId}`);
                    const contactRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${process.env.TABLE_CONTACTS || "mh4tuppyvnapu7b"}/${contactId}`, {
                        headers: { 'xc-token': NOCO_API_TOKEN }
                    });
                    const contact = contactRes.data;
                    contactEmail = contact['E-mail'] || '';
                    contactName = contact['Имя'] || '';
                    console.log(`✅ Контакт найден: ${contactName}, email: ${contactEmail}`);
                } catch (e) {
                    console.log(`⚠️ Не удалось получить контакт ID=${contactId}: ${e.message}`);
                }
            }
            
            // Получаем ID юрлица
            let legalId = null;
            if (project['Юрлицо']) {
                if (Array.isArray(project['Юрлицо']) && project['Юрлицо'].length > 0) {
                    legalId = project['Юрлицо'][0].Id || project['Юрлицо'][0];
                } else if (typeof project['Юрлицо'] === 'object' && project['Юрлицо'] !== null) {
                    legalId = project['Юрлицо'].Id;
                } else if (typeof project['Юрлицо'] === 'number') {
                    legalId = project['Юрлицо'];
                }
            }
            
            // Делаем отдельный запрос к таблице Юрлица
            if (legalId) {
                try {
                    console.log(`🔍 Запрос юрлица ID=${legalId}`);
                    const legalRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/process.env.TABLE_LEGAL_ENTITIES/${legalId}`, {
                        headers: { 'xc-token': NOCO_API_TOKEN }
                    });
                    const legal = legalRes.data;
                    legalEmail = legal['E-mail'] || '';
                    legalName = legal['Имя'] || '';
                    console.log(`✅ Юрлицо найдено: ${legalName}, email: ${legalEmail}`);
                } catch (e) {
                    console.log(`⚠️ Не удалось получить юрлицо ID=${legalId}: ${e.message}`);
                }
            }
        }        
        
        // 7. Формируем предзаполненный текст
        const docTypeName = getDocTypeName(docType);
        const projectName = project?.['Что делаем?'] || 'Проект';
        
        const defaultText = `Здравствуйте!

Направляю вам ${docTypeName} по проекту "${projectName}".

📎 Во вложении: ${pdfFileName}

Сумма: ${total.toFixed(2)} BYN

С уважением,
${responsible.name}
${responsible.phone}`;
        
        const defaultSubject = `[${docType}] по проекту "${projectName}"`;
        
        // 8. Проверяем галочку "С печатью" в документе
        const withStamp = doc['С печатью'] === true || doc['С печатью'] === 1 || doc['С печатью'] === 'true' || doc['С печатью'] === '1';
        let isNotSigned = !withStamp;
        
        // Формируем имя файла на основе галочки
        if (withStamp) {
            pdfFileName = `${htmlFile}_${docNumber}.pdf`;
        } else {
            pdfFileName = `${htmlFile}_${docNumber}_notsigned.pdf`;
        }
        
        console.log(`🔍 Галочка "С печатью": ${withStamp}, ищем файл: ${pdfFileName}`);
        
        // Ищем нужный файл
        let pdfPath = findPDFPath(pdfFileName, projectId);
        
        if (!pdfPath) {
            return res.status(404).send(getErrorHTML(
                `PDF-файл не найден: <b>${pdfFileName}</b><br><br>` +
                `Сначала сгенерируйте PDF через кнопку <b>"Сгенерировать PDF"</b>.`
            ));
        }
        
        // 9. Формируем URL для предпросмотра
        const pdfUrl = `${NOCO_BASE_URL}/pdfs/${pdfFileName}`;
        
        // 10. Показываем форму
        console.log(`🔍 isNotSigned = ${isNotSigned}, pdfFileName = ${pdfFileName}`);
        res.send(getEmailFormHTML({
            docId: docId,
            docType: docType,
            projectName: projectName,
            pdfFileName: pdfFileName,
            pdfUrl: pdfUrl,
            total: total,
            responsible: responsible,
            contactEmail: contactEmail,
            contactName: contactName,
            legalEmail: legalEmail,
            legalName: legalName,
            defaultSubject: defaultSubject,
            defaultText: defaultText,
            isNotSigned: isNotSigned
        }));
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        res.status(500).send(getErrorHTML(error.message));
    }
});

// ================== РОУТ: ОТПРАВКА EMAIL (POST) ==================
app.post('/send-email', async (req, res) => {
    const { docId, toEmail, subject, text } = req.body;
    
    if (!docId || !toEmail || !subject || !text) {
        return res.status(400).send(getErrorHTML('Заполните все поля'));
    }
    
    console.log(`\n📧 Отправка email для документа ID=${docId}`);
    
    try {
        // Получаем данные документа
        const docRes = await axios.get(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
            headers: { 'xc-token': NOCO_API_TOKEN }
        });
        const doc = docRes.data;
        
        const docType = doc['Тип документа'];
        // Используем pdfFileName из формы (тот же файл, что был показан пользователю)
        let pdfFileName = req.body.pdfFileName;
        
        // Если пришёл массив — берём первый элемент
        if (Array.isArray(pdfFileName)) {
            pdfFileName = pdfFileName[0];
        }
        
        if (!pdfFileName) {
            return res.status(400).send(getErrorHTML('Не указано имя PDF-файла'));
        }
        
        console.log(`📎 Используем файл: ${pdfFileName}`);
        
        const projectId = extractProjectId(doc['Проект']);
        const pdfPath = findPDFPath(pdfFileName, projectId);
        if (!pdfPath) {
            return res.status(404).send(getErrorHTML(`PDF-файл не найден: ${pdfFileName}`));
        }
        
        // Формируем HTML-версию письма
        const htmlText = text.replace(/\n/g, '<br>');
        
        // Отправляем email
        const result = await sendEmailWithPDF({
            toEmail: toEmail,
            subject: subject,
            text: text,
            html: `<div style="font-family: Arial, sans-serif; white-space: pre-wrap;">${htmlText}</div>`,
            pdfPath: pdfPath,
            pdfFileName: pdfFileName
        });
        
        // Обновляем статус документа
        try {
            await axios.patch(`${NOCO_API_URL}/${BASE_ID}/${TABLE_DOCS}/${docId}`, {
                'Статус': 'Отправлен',
                'Дата отправки': new Date().toLocaleString('ru-RU', { 
                    timeZone: 'Europe/Minsk', 
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                })
            }, { headers: { 'xc-token': NOCO_API_TOKEN, 'Content-Type': 'application/json' } });
        } catch (e) {
            console.log(`⚠️ Не удалось обновить статус: ${e.message}`);
        }
        
        res.send(getEmailSuccessHTML({
            docId: docId,
            docType: docType,
            toEmail: toEmail,
            pdfFileName: pdfFileName,
            messageId: result.messageId
        }));
        
    } catch (error) {
        console.error('❌ Ошибка отправки:', error.message);
        res.status(500).send(getErrorHTML(error.message));
    }
});

app.post('/generate-pdf', async (req, res) => {
    const id = parseInt(req.query.docId || req.body?.docId);
    if (!id) return res.status(400).json({ error: 'Нет ID' });
    try {
        const result = await generatePDF(id);
        res.json(result.skipped ? { status: 'skipped' } : { success: true, url: result.url });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/generate-pdf', requireSecret, async (req, res) => {
    const id = parseInt(req.query.docId);
    if (!id) return res.status(400).send('Ошибка ID');
    try {
        const result = await generatePDF(id);
        console.log(`📊 [GET /generate-pdf] Результат для ID=${id}: fileName=${result.fileName}, error=${result.error}`);
        
        if (result.error) {
            res.send(`<h1>⏳ Подождите</h1><p>${result.error}</p><meta http-equiv="refresh" content="5">`);
            return;
        }
        
        res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>PDF сгенерирован ✅</title>
    <!-- Без автоперехода -->
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; margin: 0; }
        .container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 40px; max-width: 600px; width: 100%; text-align: center; animation: slideIn 0.5s ease-out; }
        @keyframes slideIn { from { transform: translateY(-30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .icon { font-size: 80px; margin-bottom: 20px; animation: bounce 1s ease-in-out; }
        @keyframes bounce { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.2); } }
        h1 { color: #27ae60; font-size: 32px; margin-bottom: 10px; }
        .subtitle { color: #7f8c8d; font-size: 16px; margin-bottom: 30px; }
        .info-box { background: #f0fdf4; border-left: 4px solid #27ae60; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: left; }
        .info-box h3 { color: #16a34a; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; }
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #6b7280; font-weight: 500; }
        .info-value { color: #111827; font-weight: 600; }
        .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; border-radius: 10px; text-decoration: none; font-weight: 600; margin: 10px 5px; transition: transform 0.2s; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(0,0,0,0.2); }
        .btn-secondary { background: #6b7280; }
        .countdown { margin-top: 20px; color: #7f8c8d; font-size: 14px; }
        .progress-bar { width: 100%; height: 4px; background: #e5e7eb; border-radius: 2px; overflow: hidden; margin-top: 15px; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); animation: progress 5s linear forwards; }
        @keyframes progress { from { width: 100%; } to { width: 0%; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">✅</div>
        <h1>PDF успешно сгенерирован!</h1>
        <p class="subtitle">Документ готов к отправке</p>
        <div class="info-box">
            <h3>📄 Информация о документе</h3>
            <div class="info-row">
                <span class="info-label">Имя файла:</span>
                <span class="info-value">${result.fileName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Размер:</span>
                <span class="info-value">${(result.size / 1024).toFixed(1)} КБ</span>
            </div>
            <div class="info-row">
                <span class="info-label">Статус:</span>
                <span class="info-value" style="color: #27ae60;">✓ Готов к отправке</span>
            </div>
        </div>
        <a href="/send-email?docId=${id}" class="btn">📧 Отправить по email</a>
        <a href="${result.url}" target="_blank" class="btn btn-secondary">👁 Открыть PDF</a>
        <p class="subtitle" style="margin-top: 20px; font-size: 13px;">Нажмите кнопку выше для перехода к отправке</p>
    </div>
</body>
</html>`);
    } catch (e) { 
        console.error(`❌ Ошибка в GET /generate-pdf для ID=${id}:`, e.message);
        res.status(500).send(`<h1>❌ Ошибка</h1><p>${e.message}</p>`); 
    }
});

app.post('/task-update', async (req, res) => {
    try {
        console.log('\n Получен webhook для задачи');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        const taskId = req.body?.id;
        if (!taskId) {
            console.error(' Не получен ID задачи из body');
            return res.status(400).json({ error: 'Нет ID задачи в body' });
        }
        console.log(`📋 Задача ID=${taskId}`);
        await updateTask(taskId);
        res.json({ success: true, message: 'Задача обработана' });
    } catch (error) {
        console.error('❌ Ошибка обработки webhook:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ================== HTML СТРАНИЦЫ ==================

function getEmailFormHTML({ docId, docType, projectName, pdfFileName, pdfUrl, total, responsible, contactEmail, contactName, legalEmail, legalName, defaultSubject, defaultText, isNotSigned }) {
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Отправить email 📧</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    padding: 20px;
}
.container {
    background: white;
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    padding: 40px;
    max-width: 800px;
    margin: 0 auto;
}
h1 { color: #667eea; font-size: 32px; margin-bottom: 10px; }
.subtitle { color: #7f8c8d; font-size: 16px; margin-bottom: 30px; }
.info-box {
    background: #f8f9fa;
    border-left: 4px solid #667eea;
    padding: 15px;
    border-radius: 8px;
    margin: 20px 0;
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
}
.form-group {
    margin: 20px 0;
}
label {
    display: block;
    color: #2c3e50;
    font-weight: 600;
    margin-bottom: 8px;
    font-size: 14px;
}
input[type="text"], input[type="email"], textarea {
    width: 100%;
    padding: 12px;
    border: 2px solid #e0e0e0;
    border-radius: 8px;
    font-size: 15px;
    font-family: inherit;
    transition: border-color 0.3s;
}
input:focus, textarea:focus {
    outline: none;
    border-color: #667eea;
}
textarea {
    min-height: 300px;
    resize: vertical;
    font-family: 'Courier New', monospace;
}
.radio-group {
    display: flex;
    gap: 20px;
    margin: 10px 0;
}
.radio-item {
    display: flex;
    align-items: center;
    gap: 8px;
}
.radio-item input[type="radio"] {
    width: 20px;
    height: 20px;
    cursor: pointer;
}
.radio-item label {
    margin: 0;
    cursor: pointer;
    font-weight: normal;
}
.btn-group {
    display: flex;
    gap: 15px;
    margin-top: 30px;
}
.btn {
    flex: 1;
    padding: 15px 30px;
    border: none;
    border-radius: 50px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
}
.btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
}
.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
}
.email-display {
    background: #fff3cd;
    border: 2px solid #ffc107;
    border-radius: 8px;
    padding: 15px;
    margin: 15px 0;
    font-size: 18px;
    font-weight: 600;
    color: #856404;
    text-align: center;
}
.email-display.invalid {
    background: #f8d7da;
    border-color: #dc3545;
    color: #721c24;
}
.modal {
    display: none;
    position: fixed;
    z-index: 1000;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0,0,0,0.5);
    animation: fadeIn 0.3s;
}
@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}
.modal-content {
    background: white;
    margin: 10% auto;
    padding: 30px;
    border-radius: 15px;
    max-width: 500px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    animation: slideDown 0.3s;
}
@keyframes slideDown {
    from { transform: translateY(-50px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
}
.modal-icon {
    font-size: 60px;
    text-align: center;
    margin-bottom: 20px;
}
.modal h2 {
    color: #2c3e50;
    text-align: center;
    margin-bottom: 20px;
}
.modal-details {
    background: #f8f9fa;
    padding: 15px;
    border-radius: 8px;
    margin: 20px 0;
    font-size: 14px;
}
.modal-details p {
    margin: 8px 0;
}
.modal-buttons {
    display: flex;
    gap: 15px;
    margin-top: 25px;
}
.btn-secondary {
    background: #ecf0f1;
    color: #7f8c8d;
}
.btn-secondary:hover {
    background: #d5dbdb;
}
</style></head>
<body>
<div class="container">
    <h1>📧 Отправить документ по email</h1>
    <p class="subtitle">Документ: ${docType} | Проект: ${projectName}</p>
    
    <div class="info-box">
        <h3>📄 Информация</h3>
        <p><strong>Файл:</strong> ${pdfFileName}<br>
        <strong>Сумма:</strong> ${total.toFixed(2)} BYN<br>
        <strong>Ответственный:</strong> ${responsible.name} (${responsible.phone})</p>
        ${isNotSigned ? '<p style="color: #e74c3c; margin-top: 10px; font-weight: bold;">⚠️ ВНИМАНИЕ: Документ БЕЗ печати и подписи!</p>' : ''}
        <p style="margin-top: 15px;">
            <a href="${pdfUrl}" target="_blank" style="display: inline-block; background: #3498db; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 14px;">👁 Предпросмотр PDF</a>
        </p>
    </div>

    <!-- Предпросмотр PDF -->
    <div style="margin: 20px 0; border: 2px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background: #f8f9fa; padding: 10px; border-bottom: 1px solid #e0e0e0; font-size: 13px; color: #7f8c8d;">
            📄 Предпросмотр документа
        </div>
        <iframe src="${pdfUrl}" style="width: 100%; height: 500px; border: none;"></iframe>
    </div>

    <div id="emailDisplay" class="email-display">
        📧 Получатель: <span id="selectedEmail">Не выбран</span>
    </div>
    
    <form method="POST" action="/send-email" onsubmit="return validateAndConfirm(event)">
        <input type="hidden" name="docId" value="${docId}">
        <input type="hidden" name="pdfFileName" value="${pdfFileName}">
        <input type="hidden" name="pdfFileName" value="${pdfFileName}">
        
        <div class="form-group">
            <label>Кому:</label>
            <div class="radio-group">
                ${contactEmail ? `
                <div class="radio-item">
                    <input type="radio" id="contact" name="toEmail" value="${contactEmail}" ${!legalEmail ? 'checked' : ''}>
                    <label for="contact">Контакт: ${contactName} (${contactEmail})</label>
                </div>
                ` : ''}
                ${legalEmail ? `
                <div class="radio-item">
                    <input type="radio" id="legal" name="toEmail" value="${legalEmail}" ${!contactEmail ? 'checked' : ''}>
                    <label for="legal">Юрлицо: ${legalName} (${legalEmail})</label>
                </div>
                ` : ''}
            </div>
            ${!contactEmail && !legalEmail ? '<p style="color: #e74c3c;">⚠️ Email не указан ни у Контакта, ни у Юрлица</p>' : ''}
        </div>
        
        <div class="form-group">
            <label for="subject">Тема письма:</label>
            <input type="text" id="subject" name="subject" value="${defaultSubject}" required>
        </div>
        
        <div class="form-group">
            <label for="text">Текст письма:</label>
            <textarea id="text" name="text" required>${defaultText}</textarea>
        </div>
        
        <div class="btn-group">
            <button type="button" class="btn btn-secondary" onclick="window.close()">Отмена</button>
            <button type="submit" class="btn btn-primary">📧 Отправить</button>
        </div>
    </form>
</div>

<!-- Модальное окно подтверждения -->
<div id="confirmModal" class="modal">
    <div class="modal-content">
        <div class="modal-icon">⚠️</div>
        <h2>Подтвердите отправку</h2>
        <div class="modal-details">
            <p><strong>📧 Кому:</strong> <span id="modalEmail"></span></p>
            <p><strong>📄 Документ:</strong> <span id="modalDoc"></span></p>
            <p><strong>💰 Сумма:</strong> <span id="modalTotal"></span> BYN</p>
            ${isNotSigned ? '<p style="color: #e74c3c; margin-top: 10px; font-weight: bold;">⚠️ ВНИМАНИЕ: Отправляется документ БЕЗ печати и подписи!</p>' : ''}
        </div>
        <p style="text-align: center; color: #7f8c8d; font-size: 14px;">
            ${isNotSigned ? 'Вы уверены, что хотите отправить НЕПОДПИСАННЫЙ документ?' : 'Вы уверены, что хотите отправить письмо на этот адрес?'}
        </p>
        <div class="modal-buttons">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">❌ Отменить</button>
            <button type="button" class="btn btn-primary" onclick="confirmSend()">✅ Да, отправить</button>
        </div>
    </div>
</div>

<script>
// Обновляем отображение email при выборе радио-кнопки
function updateEmailDisplay() {
    const radios = document.querySelectorAll('input[name="toEmail"]');
    const emailDisplay = document.getElementById('selectedEmail');
    const emailBox = document.getElementById('emailDisplay');
    
    radios.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.checked) {
                const email = this.value;
                emailDisplay.textContent = email;
                
                // Проверяем формат email
                const emailRegex = /^[^ @]+@[^ @]+\.[^ @]+$/;
                if (!emailRegex.test(email)) {
                    emailBox.classList.add('invalid');
                    emailDisplay.textContent = email + ' ⚠️ Неверный формат';
                } else {
                    emailBox.classList.remove('invalid');
                }
            }
        });
    });
    
    // Инициализация: показываем первый выбранный email
    const checkedRadio = document.querySelector('input[name="toEmail"]:checked');
    if (checkedRadio) {
        emailDisplay.textContent = checkedRadio.value;
    }
}

// Валидация и показ модального окна
function validateAndConfirm(event) {
    event.preventDefault();
    
    const selectedRadio = document.querySelector('input[name="toEmail"]:checked');
    if (!selectedRadio) {
        alert('⚠️ Пожалуйста, выберите получателя');
        return false;
    }
    
    const email = selectedRadio.value;
    
    // Проверяем формат email
    const emailRegex = /^[^ @]+@[^ @]+\.[^ @]+$/;
    if (!emailRegex.test(email)) {
        alert('⚠️ Неверный формат email: ' + email);
        return false;
    }
    
    // Заполняем модальное окно
    document.getElementById('modalEmail').textContent = email;
    document.getElementById('modalDoc').textContent = '${pdfFileName}';
    document.getElementById('modalTotal').textContent = '${total.toFixed(2)}';
    
    // Показываем модальное окно
    document.getElementById('confirmModal').style.display = 'block';
    
    return false; // Не отправляем форму сразу
}

// Закрыть модальное окно
function closeModal() {
    document.getElementById('confirmModal').style.display = 'none';
}

// Подтвердить отправку
function confirmSend() {
    closeModal();
    document.querySelector('form').submit();
}

// Закрытие модального окна при клике вне его
window.onclick = function(event) {
    const modal = document.getElementById('confirmModal');
    if (event.target === modal) {
        closeModal();
    }
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', updateEmailDisplay);
</script>
</body></html>`;
}

function getEmailSuccessHTML({ docId, docType, toEmail, pdfFileName, messageId }) {
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Email отправлен ✅</title>
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
.info-box p {
    color: #34495e;
    font-size: 15px;
    line-height: 1.6;
}
.success-details {
    background: #d4edda;
    border: 1px solid #c3e6cb;
    color: #155724;
    padding: 15px;
    border-radius: 8px;
    margin: 20px 0;
    font-size: 13px;
    text-align: left;
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
    <div class="icon">📧</div>
    <h1>Email успешно отправлен!</h1>
    <p class="subtitle">Документ доставлен клиенту</p>
    
    <div class="info-box">
        <h3>📄 Документ</h3>
        <p><strong>${docType}</strong> (ID: ${docId})<br>
        Файл: ${pdfFileName}</p>
    </div>
    
    <div class="info-box">
        <h3>👤 Получатель</h3>
        <p><a href="mailto:${toEmail}" style="color: #11998e;">${toEmail}</a></p>
    </div>
    
    <div class="success-details">
        <strong>✅ Message ID:</strong> ${messageId}<br>
        <strong>✅ Статус в NocoDB:</strong> Отправлен<br>
        <strong>✅ PDF во вложении:</strong> ${pdfFileName}
    </div>
    
    <a href="${process.env.NOCO_URL || 'http://localhost:8081'}" class="btn">← Вернуться в NocoDB</a>
    <p class="auto-close">Эта вкладка закроется автоматически через 5 секунд...</p>
</div>
<script>setTimeout(() => window.close(), 5000);</script>
</body></html>`;
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
