ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_status_check;
ALTER TABLE conversation_messages ADD CHECK(status IN ('captured','draft','approved','sent','failed','delivery_review','cancelled'));
