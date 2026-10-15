-- Device feeds for more sectors: aviation (flight / ULD trackers → air milestones), distribution (dispatch scanners → dispatch events), moving (packing scanners → packing records).
ALTER TABLE specialist_devices DROP CONSTRAINT specialist_devices_sector_check;
ALTER TABLE specialist_devices ADD CONSTRAINT specialist_devices_sector_check CHECK (sector IN ('cold-chain','automotive-logistics','aviation-logistics','distribution','moving-relocation'));
