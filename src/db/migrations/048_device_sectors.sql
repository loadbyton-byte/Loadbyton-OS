-- Device feeds are no longer cold-chain only: a device belongs to one sector (temperature loggers for cold chain, yard scanners / telematics for automotive logistics).
ALTER TABLE specialist_devices ADD COLUMN sector text NOT NULL DEFAULT 'cold-chain' CHECK (sector IN ('cold-chain','automotive-logistics'));
ALTER TABLE device_readings ALTER COLUMN celsius DROP NOT NULL;
ALTER TABLE device_readings ADD COLUMN detail text;
