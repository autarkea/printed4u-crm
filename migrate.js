#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Читаем .env
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
        envVars[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
});

const NOCO_URL = envVars.NOCO_URL || 'http://nocodb:8080';
const TOKEN = envVars.NOCO_TOKEN;
const BASE_ID = envVars.BASE_ID;

if (!TOKEN || !BASE_ID) {
    console.error('❌ Ошибка: Заполни NOCO_TOKEN и BASE_ID в файле .env');
    process.exit(1);
}

const tablesSchema = [
    { 
        table_name: 'Задачи', 
        title: 'Задачи', 
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Описание', title: 'Описание', uidt: 'LongText' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', dtxp: "'Новая','В работе','Готово','Отменено'" },
            { column_name: 'Приоритет', title: 'Приоритет', uidt: 'SingleSelect', dtxp: "'Низкий','Средний','Высокий','Срочный'" },
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
            { column_name: 'Тип', title: 'Тип', uidt: 'SingleSelect', dtxp: "'Клиент','Партнёр','Поставщик'" }
        ]
    },
    { 
        table_name: 'Проекты', 
        title: 'Проекты', 
        columns: [
            { column_name: 'Название', title: 'Название', uidt: 'SingleLineText' },
            { column_name: 'Контакт', title: 'Контакт', uidt: 'SingleLineText' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', dtxp: "'Новый','В работе','Завершён','Приостановлен'" },
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
            { column_name: 'Тип', title: 'Тип', uidt: 'SingleSelect', dtxp: "'Счёт','Акт','Накладная','Договор'" },
            { column_name: 'Проект', title: 'Проект', uidt: 'SingleLineText' },
            { column_name: 'Контакт', title: 'Контакт', uidt: 'SingleLineText' },
            { column_name: 'Сумма', title: 'Сумма', uidt: 'Decimal' },
            { column_name: 'Статус', title: 'Статус', uidt: 'SingleSelect', dtxp: "'Черновик','Отправлен','Оплачен','Подписан'" },
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
            { column_name: 'Количество', title: 'Количество', uidt: 'Decimal' },
            { column_name: 'Цена', title: 'Цена', uidt: 'Decimal' },
            { column_name: 'Сумма', title: 'Сумма', uidt: 'Decimal' },
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

async function createTable(table) {
    console.log(`\n📋 Создаю таблицу: ${table.title}...`);
    try {
        const res = await fetch(`${NOCO_URL}/api/v2/meta/bases/${BASE_ID}/tables`, {
            method: 'POST',
            headers: { 
                'xc-token': TOKEN, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ 
                table_name: table.table_name, 
                title: table.title, 
                columns: table.columns 
            })
        });
        
        if (res.ok) {
            const data = await res.json();
            console.log(`   ✅ Таблица создана! ID: ${data.id}`);
        } else {
            const text = await res.text();
            if (text.includes('already exists')) {
                console.log(`   ⚠️  Таблица уже существует, пропускаю`);
            } else {
                console.error(`   ❌ Ошибка: ${text}`);
            }
        }
    } catch (error) {
        console.error(`   ❌ Ошибка сети: ${error.message}`);
    }
}

async function main() {
    console.log('🚀 Начинаю автоматическую настройку NocoDB...');
    console.log(`📡 URL: ${NOCO_URL}`);
    console.log(`🔑 Base ID: ${BASE_ID}`);

    for (const table of tablesSchema) {
        await createTable(table);
    }

    console.log('\n🎉 Все таблицы успешно созданы!');
}

main().catch(console.error);
