#!/usr/bin/env node

/**
 * Автоматическое создание таблиц в NocoDB
 * Запуск: node setup.js
 */

const fs = require('fs');
const path = require('path');

// Читаем .env
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) envVars[key.trim()] = value.trim();
});

const NOCO_URL = envVars.NOCO_URL || 'http://localhost:8081';
const TOKEN = envVars.NOCO_TOKEN;
const BASE_ID = envVars.BASE_ID;

if (!TOKEN || !BASE_ID) {
    console.error('❌ Ошибка: Заполни NOCO_TOKEN и BASE_ID в файле .env');
    process.exit(1);
}

// Структура таблиц и колонок
const tablesSchema = [
    {
        table_name: 'Задачи',
        title: 'Задачи',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Описание', title: 'Описание', uidt: 'LongText' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Новая' }, { title: 'В работе' }, { title: 'Готово' }, { title: 'Отменено' }] } },
            { column_name: 'Приоритет', title: 'Приоритет', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Низкий' }, { title: 'Средний' }, { title: 'Высокий' }, { title: 'Срочный' }] } },
            { column_name: 'Дедлайн', title: 'Дедлайн', uidt: 'DateTime' },
            { column_name: 'Проект', title: 'Проект', uidt: 'SingleLineText' },
            { column_name: 'Контакт', title: 'Контакт', uidt: 'SingleLineText' }
        ]
    },
    {
        table_name: 'Контакты',
        title: 'Контакты',
        columns: [
            { column_name: 'Имя', title: 'Имя', uidt: 'SingleLineText' },
            { column_name: 'Телефон', title: 'Телефон', uidt: 'PhoneNumber' },
            { column_name: 'Email', title: 'Email', uidt: 'Email' },
            { column_name: 'Telegram', title: 'Telegram', uidt: 'SingleLineText' },
            { column_name: 'Компания', title: 'Компания', uidt: 'SingleLineText' },
            { column_name: 'Тип', title: 'Тип', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Клиент' }, { title: 'Партнёр' }, { title: 'Поставщик' }] } }
        ]
    },
    {
        table_name: 'Проекты',
        title: 'Проекты',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Контакт', title: 'Контакт', uidt: 'SingleLineText' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Новый' }, { title: 'В работе' }, { title: 'Завершён' }, { title: 'Приостановлен' }] } },
            { column_name: 'Дата начала', title: 'Дата начала', uidt: 'DateTime' },
            { column_name: 'Дата окончания', title: 'Дата окончания', uidt: 'DateTime' },
            { column_name: 'Описание', title: 'Описание', uidt: 'LongText' },
            { column_name: 'Папка проекта', title: 'Папка проекта', uidt: 'SingleLineText' }
        ]
    },
    {
        table_name: 'Документы',
        title: 'Документы',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Тип', title: 'Тип', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Счёт' }, { title: 'Акт' }, { title: 'Накладная' }, { title: 'Договор' }] } },
            { column_name: 'Проект', title: 'Проект', uidt: 'SingleLineText' },
            { column_name: 'Контакт', title: 'Контакт', uidt: 'SingleLineText' },
            { column_name: 'Сумма', title: 'Сумма', uidt: 'Number' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', colOptions: { options: [{ title: 'Черновик' }, { title: 'Отправлен' }, { title: 'Оплачен' }, { title: 'Подписан' }] } },
            { column_name: 'Дата', title: 'Дата', uidt: 'DateTime' },
            { column_name: 'PDF путь', title: 'PDF путь', uidt: 'SingleLineText' }
        ]
    },
    {
        table_name: 'Позиции',
        title: 'Позиции',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Документ', title: 'Документ', uidt: 'SingleLineText' },
            { column_name: 'Количество', title: 'Количество', uidt: 'Number' },
            { column_name: 'Цена', title: 'Цена', uidt: 'Number' },
            { column_name: 'Сумма', title: 'Сумма', uidt: 'Number' },
            { column_name: 'Описание', title: 'Описание', uidt: 'LongText' }
        ]
    },
    {
        table_name: 'Юрлица',
        title: 'Юрлица',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'ИНН', title: 'ИНН', uidt: 'SingleLineText' },
            { column_name: 'КПП', title: 'КПП', uidt: 'SingleLineText' },
            { column_name: 'ОГРН', title: 'ОГРН', uidt: 'SingleLineText' },
            { column_name: 'Адрес', title: 'Адрес', uidt: 'LongText' },
            { column_name: 'Банк', title: 'Банк', uidt: 'SingleLineText' },
            { column_name: 'Расчётный счёт', title: 'Расчётный счёт', uidt: 'SingleLineText' },
            { column_name: 'Корр счёт', title: 'Корр счёт', uidt: 'SingleLineText' },
            { column_name: 'БИК', title: 'БИК', uidt: 'SingleLineText' }
        ]
    },
    {
        table_name: 'Мои реквизиты',
        title: 'Мои реквизиты',
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Юрлицо', title: 'Юрлицо', uidt: 'SingleLineText' },
            { column_name: 'Директор', title: 'Директор', uidt: 'SingleLineText' },
            { column_name: 'Телефон', title: 'Телефон', uidt: 'PhoneNumber' },
            { column_name: 'Email', title: 'Email', uidt: 'Email' },
            { column_name: 'Сайт', title: 'Сайт', uidt: 'URL' }
        ]
    }
];

async function createTable(axios, table) {
    console.log(`\n📋 Создаю таблицу: ${table.title}...`);
    try {
        // Создаем таблицу
        const res = await axios.post(`/api/v1/db/meta/bases/${BASE_ID}/tables`, {
            table_name: table.table_name,
            title: table.title,
            columns: table.columns
        });
        console.log(`   ✅ Таблица создана! ID: ${res.data.id}`);
    } catch (error) {
        if (error.response && error.response.status === 400) {
            console.log(`   ⚠️  Таблица уже существует, пропускаю`);
        } else {
            console.error(`   ❌ Ошибка:`, error.response?.data || error.message);
        }
    }
}

async function main() {
    // Динамический импорт axios (так как он в bot/package.json)
    let axios;
    try {
        axios = require('axios');
    } catch (e) {
        console.log(' Устанавливаю axios...');
        require('child_process').execSync('npm install axios');
        axios = require('axios');
    }

    const api = axios.create({
        baseURL: NOCO_URL,
        headers: { 'xc-token': TOKEN }
    });

    console.log(' Начинаю автоматическую настройку NocoDB...');
    console.log(` URL: ${NOCO_URL}`);
    console.log(`🔑 Base ID: ${BASE_ID}`);

    for (const table of tablesSchema) {
        await createTable(api, table);
    }

    console.log('\n🎉 Все таблицы успешно созданы!');
    console.log('Теперь можно перезапустить бота: docker compose restart bot');
}

main().catch(console.error);
