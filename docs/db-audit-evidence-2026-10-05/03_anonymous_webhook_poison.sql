begin;
set local role anon;select claim_webhook_update('synthetic-telegram','999');select finish_webhook_update('synthetic-telegram','999');reset role;select status from processed_webhooks where source='synthetic-telegram';
rollback;
