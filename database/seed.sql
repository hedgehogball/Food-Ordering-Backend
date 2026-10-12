-- Default non-customer data only. INSERT IGNORE preserves occupied tables and settings.
SET NAMES utf8mb4;
INSERT IGNORE INTO lj_settings (id,document) VALUES
  ('shop','{"version":1,"open":true,"useHours":false,"openTime":"10:00","closeTime":"23:00","weekdays":[1,2,3,4,5,6,7],"leadMinutes":15,"advanceDays":7}');

INSERT IGNORE INTO lj_dining_tables (id,document) VALUES
  ('01','{"id":"01","sessionId":""}'),
  ('02','{"id":"02","sessionId":""}'),
  ('03','{"id":"03","sessionId":""}'),
  ('04','{"id":"04","sessionId":""}'),
  ('05','{"id":"05","sessionId":""}'),
  ('06','{"id":"06","sessionId":""}'),
  ('07','{"id":"07","sessionId":""}'),
  ('08','{"id":"08","sessionId":""}'),
  ('09','{"id":"09","sessionId":""}'),
  ('10','{"id":"10","sessionId":""}'),
  ('11','{"id":"11","sessionId":""}'),
  ('12','{"id":"12","sessionId":""}'),
  ('13','{"id":"13","sessionId":""}'),
  ('14','{"id":"14","sessionId":""}'),
  ('15','{"id":"15","sessionId":""}'),
  ('16','{"id":"16","sessionId":""}'),
  ('17','{"id":"17","sessionId":""}'),
  ('18','{"id":"18","sessionId":""}'),
  ('19','{"id":"19","sessionId":""}'),
  ('20','{"id":"20","sessionId":""}'),
  ('21','{"id":"21","sessionId":""}'),
  ('22','{"id":"22","sessionId":""}'),
  ('23','{"id":"23","sessionId":""}'),
  ('24','{"id":"24","sessionId":""}');
