-- One postgres instance serves every region of the ws-tests stand; each region gets its own
-- database. Keeping them apart mirrors production (separate servers) without the second engine.
CREATE DATABASE region_main;
CREATE DATABASE region_europe;
