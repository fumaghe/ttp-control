-- Pannello persistente che elenca i membri sotto il rispettivo rank TTP.
-- Additiva e ripetibile: nessun record esistente viene modificato.
ALTER TYPE "PanelType" ADD VALUE IF NOT EXISTS 'HIERARCHY';
