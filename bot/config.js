
module.exports = {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MY_ID: parseInt(process.env.TELEGRAM_USER_ID),
    CRON_TIME: process.env.MORNING_CRON || '0 10 * * *',
    NOCO_URL: 'http://host.docker.internal:8081/api/v1/db/data',
    NOCO_TOKEN: process.env.NOCO_TOKEN,
    BASE_ID: process.env.BASE_ID,
    TABLES: {
        TASKS: process.env.TABLE_TASKS,
        CONTACTS: process.env.TABLE_CONTACTS,
        PROJECTS: process.env.TABLE_PROJECTS
    
        DOCUMENTS: process.env.TABLE_DOCUMENTS,
        ITEMS: process.env.TABLE_ITEMS,
        LEGAL_ENTITIES: process.env.TABLE_LEGAL_ENTITIES,
        MY_DETAILS: process.env.TABLE_MY_DETAILS},
    VALID_MESSENGERS: ['Telegram', 'Viber', 'Куфар']
};
