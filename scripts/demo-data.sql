BEGIN;

-- 1. EMPRESAS
INSERT INTO companies (id, name, type, company_types, address, phone, email, rut, active, has_internal_fleet, lat, lng, created_at, updated_at) VALUES
('c-prod-trillo',   'El Trillo',              'producer',    '["producer"]',    'Ruta 2 km 245, Soriano',                  '+598 91 234 001', 'contacto@eltrillo.uy',       '211234560018', true, true,  -33.8800, -57.5100, NOW(), NOW()),
('c-prod-palermo',  'Estancia Palermo',       'producer',    '["producer"]',    'Ruta 21 km 180, Colonia',                 '+598 91 234 002', 'contacto@palermo.uy',        '211234560019', true, false, -34.1500, -57.8500, NOW(), NOW()),
('c-plant-fomento', 'Fomento NH',             'plant',       '["plant"]',       'Ruta 1 km 120, Nueva Helvecia, Colonia',  '+598 91 234 007', 'recepcion@fomentohn.uy',     '211234560024', true, true,  -34.3100, -57.2400, NOW(), NOW()),
('c-plant-sofoval', 'SOFOVAL',                'plant',       '["plant"]',       'Ruta 2 km 280, Soriano',                  '+598 91 234 003', 'recepcion@sofoval.uy',       '211234560020', true, true,  -33.8600, -57.5300, NOW(), NOW()),
('c-plant-agro',    'AGROTERRA',              'plant',       '["plant"]',       'Ruta 3 km 310, Rio Negro',                '+598 91 234 004', 'operaciones@agroterra.uy',   '211234560021', true, true,  -33.1200, -58.0800, NOW(), NOW()),
('c-plant-fadisol', 'FADISOL',                'plant',       '["plant"]',       'Ruta 1 km 185, Colonia del Sacramento',   '+598 91 234 008', 'planta@fadisol.uy',          '211234560025', true, true,  -34.4500, -57.8600, NOW(), NOW()),
('c-trans-colonia', 'Transportes Colonia',    'transporter', '["transporter"]', 'Av. Artigas 450, Colonia del Sacramento', '+598 91 234 005', 'flota@transcolonia.uy',      '211234560022', true, false, -34.4600, -57.8400, NOW(), NOW()),
('c-trans-helve',   'Transportes Helvecia',   'transporter', '["transporter"]', 'Calle Principal 120, Nueva Helvecia',     '+598 91 234 006', 'despacho@transhelvecia.uy',  '211234560023', true, false, -34.3000, -57.2300, NOW(), NOW());

-- 2. PLANTAS
INSERT INTO plants (id, name, company_id, address, lat, lng, active, created_at, updated_at) VALUES
('pl-fomento', 'Fomento NH', 'c-plant-fomento', 'Ruta 1 km 120, Nueva Helvecia',       -34.3100, -57.2400, true, NOW(), NOW()),
('pl-sofoval', 'SOFOVAL',    'c-plant-sofoval', 'Ruta 2 km 280, Soriano',               -33.8600, -57.5300, true, NOW(), NOW()),
('pl-agro',    'AGROTERRA',  'c-plant-agro',    'Ruta 3 km 310, Rio Negro',             -33.1200, -58.0800, true, NOW(), NOW()),
('pl-fadisol', 'FADISOL',    'c-plant-fadisol', 'Ruta 1 km 185, Colonia del Sacramento',-34.4500, -57.8600, true, NOW(), NOW());

-- 3. SUCURSALES
INSERT INTO branches (id, name, company_id, address, reference, lat, lng, active, created_at, updated_at) VALUES
('br-fom-nh',   'Nueva Helvecia', 'c-plant-fomento', 'Ruta 1 km 120, Nueva Helvecia', 'Entrada principal',       -34.3100, -57.2400, true, NOW(), NOW()),
('br-fom-jl',   'Juan Lacaze',    'c-plant-fomento', 'Ruta 1 km 155, Juan Lacaze',     'Zona portuaria',          -34.4300, -57.4500, true, NOW(), NOW()),
('br-sof-mig',  'Miguelete',      'c-plant-sofoval', 'Ruta 2 km 260, Miguelete',       'Frente al silo grande',   -33.8900, -57.4800, true, NOW(), NOW()),
('br-sof-val',  'Valdense',       'c-plant-sofoval', 'Camino Valdense s/n',             'A 2km de Ruta 1',         -34.3100, -57.2400, true, NOW(), NOW()),
('br-agro-yn',  'Young',          'c-plant-agro',    'Zona Industrial, Young',          'Detras de la balanza',    -32.6900, -57.6300, true, NOW(), NOW()),
('br-agro-nh',  'Nueva Helvecia', 'c-plant-agro',    'Ruta 1 km 118, Nueva Helvecia',  'Frente a Fomento',        -34.3050, -57.2350, true, NOW(), NOW()),
('br-fad-col',  'Colonia',        'c-plant-fadisol', 'Ruta 1 km 185, Colonia',          'Junto a la bascula',      -34.4500, -57.8600, true, NOW(), NOW()),
('br-fad-car',  'Carmelo',        'c-plant-fadisol', 'Camino al puerto, Carmelo',       'Puerto de Carmelo',       -34.0000, -58.2800, true, NOW(), NOW());

-- 4. USUARIOS (password: Tolvink2026)
INSERT INTO users (id, email, password_hash, name, role, company_id, phone, user_types, company_by_type, is_super_admin, active, active_company_id, created_at, updated_at) VALUES
('u-trillo-admin', 'martin@eltrillo.uy',     '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Martin Rodriguez',  'admin',    'c-prod-trillo',   '+598 92 100 001', '["producer"]',    '{"producer":"c-prod-trillo"}',    false, true, 'c-prod-trillo',   NOW(), NOW()),
('u-trillo-oper',  'lucia@eltrillo.uy',      '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Lucia Fernandez',   'operator', 'c-prod-trillo',   '+598 92 100 002', '["producer"]',    '{"producer":"c-prod-trillo"}',    false, true, 'c-prod-trillo',   NOW(), NOW()),
('u-trillo-chofer','carlos@eltrillo.uy',     '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Carlos Perez',      'operator', 'c-prod-trillo',   '+598 92 100 003', '["producer"]',    '{"producer":"c-prod-trillo"}',    false, true, 'c-prod-trillo',   NOW(), NOW()),
('u-palermo-admin','roberto@palermo.uy',     '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Roberto Gutierrez', 'admin',    'c-prod-palermo',  '+598 92 100 004', '["producer"]',    '{"producer":"c-prod-palermo"}',   false, true, 'c-prod-palermo',  NOW(), NOW()),
('u-fomento-admin','rodolfo@fomentohn.uy',   '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Rodolfo Vera',      'admin',    'c-plant-fomento', '+598 92 100 013', '["plant"]',       '{"plant":"c-plant-fomento"}',     false, true, 'c-plant-fomento', NOW(), NOW()),
('u-fomento-ch1',  'walter@fomentohn.uy',    '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Walter Diaz',       'operator', 'c-plant-fomento', '+598 92 100 020', '["plant"]',       '{"plant":"c-plant-fomento"}',     false, true, 'c-plant-fomento', NOW(), NOW()),
('u-fomento-ch2',  'nelson@fomentohn.uy',    '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Nelson Correa',     'operator', 'c-plant-fomento', '+598 92 100 021', '["plant"]',       '{"plant":"c-plant-fomento"}',     false, true, 'c-plant-fomento', NOW(), NOW()),
('u-fomento-ch3',  'hugo@fomentohn.uy',      '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Hugo Ramos',        'operator', 'c-plant-fomento', '+598 92 100 022', '["plant"]',       '{"plant":"c-plant-fomento"}',     false, true, 'c-plant-fomento', NOW(), NOW()),
('u-sofoval-admin','andrea@sofoval.uy',      '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Andrea Martinez',   'admin',    'c-plant-sofoval', '+598 92 100 005', '["plant"]',       '{"plant":"c-plant-sofoval"}',     false, true, 'c-plant-sofoval', NOW(), NOW()),
('u-sofoval-oper', 'diego@sofoval.uy',       '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Diego Lopez',       'operator', 'c-plant-sofoval', '+598 92 100 006', '["plant"]',       '{"plant":"c-plant-sofoval"}',     false, true, 'c-plant-sofoval', NOW(), NOW()),
('u-sofoval-ch1',  'oscar@sofoval.uy',       '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Oscar Silveira',    'operator', 'c-plant-sofoval', '+598 92 100 023', '["plant"]',       '{"plant":"c-plant-sofoval"}',     false, true, 'c-plant-sofoval', NOW(), NOW()),
('u-sofoval-ch2',  'ruben@sofoval.uy',       '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Ruben Castro',      'operator', 'c-plant-sofoval', '+598 92 100 024', '["plant"]',       '{"plant":"c-plant-sofoval"}',     false, true, 'c-plant-sofoval', NOW(), NOW()),
('u-sofoval-ch3',  'daniel@sofoval.uy',      '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Daniel Pereyra',    'operator', 'c-plant-sofoval', '+598 92 100 025', '["plant"]',       '{"plant":"c-plant-sofoval"}',     false, true, 'c-plant-sofoval', NOW(), NOW()),
('u-agro-admin',   'patricia@agroterra.uy',  '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Patricia Suarez',   'admin',    'c-plant-agro',    '+598 92 100 007', '["plant"]',       '{"plant":"c-plant-agro"}',        false, true, 'c-plant-agro',    NOW(), NOW()),
('u-agro-ch1',     'alvaro@agroterra.uy',    '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Alvaro Techera',    'operator', 'c-plant-agro',    '+598 92 100 026', '["plant"]',       '{"plant":"c-plant-agro"}',        false, true, 'c-plant-agro',    NOW(), NOW()),
('u-agro-ch2',     'marcelo@agroterra.uy',   '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Marcelo Gimenez',   'operator', 'c-plant-agro',    '+598 92 100 027', '["plant"]',       '{"plant":"c-plant-agro"}',        false, true, 'c-plant-agro',    NOW(), NOW()),
('u-agro-ch3',     'gustavo@agroterra.uy',   '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Gustavo Morales',   'operator', 'c-plant-agro',    '+598 92 100 028', '["plant"]',       '{"plant":"c-plant-agro"}',        false, true, 'c-plant-agro',    NOW(), NOW()),
('u-fadisol-admin','santiago@fadisol.uy',    '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Santiago Bentancor','admin',    'c-plant-fadisol', '+598 92 100 014', '["plant"]',       '{"plant":"c-plant-fadisol"}',     false, true, 'c-plant-fadisol', NOW(), NOW()),
('u-fadisol-ch1',  'sergio@fadisol.uy',      '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Sergio Viera',      'operator', 'c-plant-fadisol', '+598 92 100 029', '["plant"]',       '{"plant":"c-plant-fadisol"}',     false, true, 'c-plant-fadisol', NOW(), NOW()),
('u-fadisol-ch2',  'fernando@fadisol.uy',    '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Fernando Cardozo',  'operator', 'c-plant-fadisol', '+598 92 100 030', '["plant"]',       '{"plant":"c-plant-fadisol"}',     false, true, 'c-plant-fadisol', NOW(), NOW()),
('u-fadisol-ch3',  'gabriel@fadisol.uy',     '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Gabriel Pereira',   'operator', 'c-plant-fadisol', '+598 92 100 031', '["plant"]',       '{"plant":"c-plant-fadisol"}',     false, true, 'c-plant-fadisol', NOW(), NOW()),
('u-colonia-admin','jorge@transcolonia.uy',  '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Jorge Mendez',      'admin',    'c-trans-colonia', '+598 92 100 008', '["transporter"]', '{"transporter":"c-trans-colonia"}',false, true, 'c-trans-colonia', NOW(), NOW()),
('u-colonia-ch1',  'miguel@transcolonia.uy', '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Miguel Acosta',     'operator', 'c-trans-colonia', '+598 92 100 009', '["transporter"]', '{"transporter":"c-trans-colonia"}',false, true, 'c-trans-colonia', NOW(), NOW()),
('u-colonia-ch2',  'pedro@transcolonia.uy',  '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Pedro Nunez',       'operator', 'c-trans-colonia', '+598 92 100 010', '["transporter"]', '{"transporter":"c-trans-colonia"}',false, true, 'c-trans-colonia', NOW(), NOW()),
('u-helve-admin',  'raul@transhelvecia.uy',  '$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Raul Bentancor',    'admin',    'c-trans-helve',   '+598 92 100 011', '["transporter"]', '{"transporter":"c-trans-helve"}',  false, true, 'c-trans-helve',   NOW(), NOW()),
('u-helve-ch1',    'fabian@transhelvecia.uy','$2a$10$Qf7vjADxWS.ReAo1e43Ch.nZNaSa4Z0cMvfS63bPyEH7z4LbUhFJC', 'Fabian Olivera',    'operator', 'c-trans-helve',   '+598 92 100 012', '["transporter"]', '{"transporter":"c-trans-helve"}',  false, true, 'c-trans-helve',   NOW(), NOW());

-- 5. MEMBRESÍAS
INSERT INTO user_companies (id, user_id, company_id, role, active, created_at, updated_at) VALUES
('uc-01', 'u-trillo-admin',  'c-prod-trillo',   'gerente',  true, NOW(), NOW()),
('uc-02', 'u-trillo-oper',   'c-prod-trillo',   'operario', true, NOW(), NOW()),
('uc-03', 'u-trillo-chofer', 'c-prod-trillo',   'chofer',   true, NOW(), NOW()),
('uc-04', 'u-palermo-admin', 'c-prod-palermo',  'gerente',  true, NOW(), NOW()),
('uc-05', 'u-fomento-admin', 'c-plant-fomento', 'gerente',  true, NOW(), NOW()),
('uc-06', 'u-fomento-ch1',   'c-plant-fomento', 'chofer',   true, NOW(), NOW()),
('uc-07', 'u-fomento-ch2',   'c-plant-fomento', 'chofer',   true, NOW(), NOW()),
('uc-08', 'u-fomento-ch3',   'c-plant-fomento', 'chofer',   true, NOW(), NOW()),
('uc-09', 'u-sofoval-admin', 'c-plant-sofoval', 'gerente',  true, NOW(), NOW()),
('uc-10', 'u-sofoval-oper',  'c-plant-sofoval', 'operario', true, NOW(), NOW()),
('uc-11', 'u-sofoval-ch1',   'c-plant-sofoval', 'chofer',   true, NOW(), NOW()),
('uc-12', 'u-sofoval-ch2',   'c-plant-sofoval', 'chofer',   true, NOW(), NOW()),
('uc-13', 'u-sofoval-ch3',   'c-plant-sofoval', 'chofer',   true, NOW(), NOW()),
('uc-14', 'u-agro-admin',    'c-plant-agro',    'gerente',  true, NOW(), NOW()),
('uc-15', 'u-agro-ch1',      'c-plant-agro',    'chofer',   true, NOW(), NOW()),
('uc-16', 'u-agro-ch2',      'c-plant-agro',    'chofer',   true, NOW(), NOW()),
('uc-17', 'u-agro-ch3',      'c-plant-agro',    'chofer',   true, NOW(), NOW()),
('uc-18', 'u-fadisol-admin', 'c-plant-fadisol', 'gerente',  true, NOW(), NOW()),
('uc-19', 'u-fadisol-ch1',   'c-plant-fadisol', 'chofer',   true, NOW(), NOW()),
('uc-20', 'u-fadisol-ch2',   'c-plant-fadisol', 'chofer',   true, NOW(), NOW()),
('uc-21', 'u-fadisol-ch3',   'c-plant-fadisol', 'chofer',   true, NOW(), NOW()),
('uc-22', 'u-colonia-admin', 'c-trans-colonia', 'gerente',  true, NOW(), NOW()),
('uc-23', 'u-colonia-ch1',   'c-trans-colonia', 'chofer',   true, NOW(), NOW()),
('uc-24', 'u-colonia-ch2',   'c-trans-colonia', 'chofer',   true, NOW(), NOW()),
('uc-25', 'u-helve-admin',   'c-trans-helve',   'gerente',  true, NOW(), NOW()),
('uc-26', 'u-helve-ch1',     'c-trans-helve',   'chofer',   true, NOW(), NOW()),
('uc-27', 'u-trillo-admin',  'c-prod-palermo',  'gerente',  true, NOW(), NOW());

-- 6. ACCESOS PLANTA-PRODUCTOR
INSERT INTO plant_producer_access (id, plant_company_id, producer_company_id, allowed_plant_ids, allowed_branch_ids, active, created_at, updated_at) VALUES
('ppa-01', 'c-plant-fomento', 'c-prod-trillo',  '[]', '[]', true, NOW(), NOW()),
('ppa-02', 'c-plant-fomento', 'c-prod-palermo', '[]', '[]', true, NOW(), NOW()),
('ppa-03', 'c-plant-sofoval', 'c-prod-trillo',  '[]', '[]', true, NOW(), NOW()),
('ppa-04', 'c-plant-sofoval', 'c-prod-palermo', '[]', '[]', true, NOW(), NOW()),
('ppa-05', 'c-plant-agro',    'c-prod-trillo',  '[]', '[]', true, NOW(), NOW()),
('ppa-06', 'c-plant-agro',    'c-prod-palermo', '[]', '[]', true, NOW(), NOW()),
('ppa-07', 'c-plant-fadisol', 'c-prod-trillo',  '[]', '[]', true, NOW(), NOW()),
('ppa-08', 'c-plant-fadisol', 'c-prod-palermo', '[]', '[]', true, NOW(), NOW());

-- 7. CAMPOS Y LOTES
INSERT INTO fields (id, name, company_id, address, lat, lng, hectares, active, created_at, updated_at) VALUES
('f-cerros',  'Cerros Negros',   'c-prod-trillo',  'Ruta 52 km 12, Soriano',   -33.8500, -57.5400, 320,  true, NOW(), NOW()),
('f-frente',  'Frente',          'c-prod-trillo',  'Camino vecinal s/n',        -33.9100, -57.4900, 180,  true, NOW(), NOW()),
('f-palermo', 'Campo Palermo',   'c-prod-palermo', 'Ruta 21 km 175, Colonia',  -34.1600, -57.8200, 450,  true, NOW(), NOW());

INSERT INTO lots (id, name, company_id, field_id, hectares, lat, lng, active, created_at, updated_at) VALUES
('l-maizales',  'Maizales',  'c-prod-trillo',  'f-cerros',  120, -33.8450, -57.5350, true, NOW(), NOW()),
('l-bajo',      'Bajo',      'c-prod-trillo',  'f-cerros',  100, -33.8550, -57.5450, true, NOW(), NOW()),
('l-loma',      'Loma',      'c-prod-trillo',  'f-cerros',  100, -33.8400, -57.5500, true, NOW(), NOW()),
('l-frente1',   'Lote 1',   'c-prod-trillo',  'f-frente',   90, -33.9050, -57.4850, true, NOW(), NOW()),
('l-frente2',   'Lote 2',   'c-prod-trillo',  'f-frente',   90, -33.9150, -57.4950, true, NOW(), NOW()),
('l-pal-norte', 'Norte',    'c-prod-palermo', 'f-palermo', 200, -34.1500, -57.8100, true, NOW(), NOW()),
('l-pal-sur',   'Sur',      'c-prod-palermo', 'f-palermo', 250, -34.1700, -57.8300, true, NOW(), NOW());

-- 8. POIs
INSERT INTO pois (id, name, company_id, lat, lng, active, created_at, updated_at) VALUES
('poi-balanza', 'Balanza Ruta 2',  'c-prod-trillo',  -33.8700, -57.5200, true, NOW(), NOW()),
('poi-cruce',   'Cruce Ruta 52',   'c-prod-trillo',  -33.8600, -57.5100, true, NOW(), NOW());

-- 9. CAMIONES
INSERT INTO trucks (id, plate, brand, model, capacity, company_id, assigned_user_id, active, created_at, updated_at) VALUES
('t-trillo-01',  'SBC 2045', 'Scania',   'R450',    '30', 'c-prod-trillo',   'u-trillo-chofer', true, NOW(), NOW()),
('t-trillo-02',  'LAC 9011', 'Mercedes', 'Actros',  '28', 'c-prod-trillo',   NULL,              true, NOW(), NOW()),
('t-fomento-01', 'FNH 1001', 'Volvo',    'FH 460',  '30', 'c-plant-fomento', 'u-fomento-ch1',   true, NOW(), NOW()),
('t-fomento-02', 'FNH 1002', 'Scania',   'R410',    '32', 'c-plant-fomento', 'u-fomento-ch2',   true, NOW(), NOW()),
('t-sofoval-01', 'SOF 2001', 'Mercedes', 'Axor',    '30', 'c-plant-sofoval', 'u-sofoval-ch1',   true, NOW(), NOW()),
('t-sofoval-02', 'SOF 2002', 'Iveco',    'Stralis', '28', 'c-plant-sofoval', 'u-sofoval-ch2',   true, NOW(), NOW()),
('t-agro-01',    'AGR 3001', 'Scania',   'G460',    '32', 'c-plant-agro',    'u-agro-ch1',      true, NOW(), NOW()),
('t-agro-02',    'AGR 3002', 'Volvo',    'FH 540',  '30', 'c-plant-agro',    'u-agro-ch2',      true, NOW(), NOW()),
('t-fadisol-01', 'FAD 4001', 'Mercedes', 'Actros',  '30', 'c-plant-fadisol', 'u-fadisol-ch1',   true, NOW(), NOW()),
('t-fadisol-02', 'FAD 4002', 'Scania',   'R500',    '32', 'c-plant-fadisol', 'u-fadisol-ch2',   true, NOW(), NOW()),
('t-colonia-01', 'ABC 1234', 'Volvo',    'FH 540',  '32', 'c-trans-colonia', 'u-colonia-ch1',   true, NOW(), NOW()),
('t-colonia-02', 'DEF 5678', 'Scania',   'R500',    '30', 'c-trans-colonia', 'u-colonia-ch2',   true, NOW(), NOW()),
('t-colonia-03', 'GHI 9012', 'Iveco',    'Stralis', '28', 'c-trans-colonia', NULL,              true, NOW(), NOW()),
('t-helve-01',   'JKL 3456', 'Mercedes', 'Axor',    '30', 'c-trans-helve',   'u-helve-ch1',     true, NOW(), NOW()),
('t-helve-02',   'MNO 7890', 'Scania',   'G460',    '32', 'c-trans-helve',   NULL,              true, NOW(), NOW());

-- 10. FLETES

-- Flete 1: PENDIENTE
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, notes, created_at, updated_at) VALUES
('fr-01', 'F26-DEM.0001', 'pending_assignment', 'c-prod-trillo', 'Cerros Negros / Maizales', -33.8450, -57.5350, 'f-cerros', 'l-maizales', 'c-plant-sofoval', 'SOFOVAL Miguelete', -33.8900, -57.4800, 'pl-sofoval', CURRENT_DATE + 1, '08:00', 'u-trillo-admin', 1, 0, false, false, ARRAY['c-prod-trillo','c-plant-sofoval'], 'Soja primera calidad', NOW() - INTERVAL '2 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-01', 'fr-01', 'Soja', 30, NOW());

-- Flete 2: ASIGNADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, created_at, updated_at) VALUES
('fr-02', 'F26-DEM.0002', 'assigned', 'c-prod-trillo', 'Cerros Negros / Bajo', -33.8550, -57.5450, 'f-cerros', 'l-bajo', 'c-plant-fomento', 'Fomento NH Nueva Helvecia', -34.3100, -57.2400, 'pl-fomento', CURRENT_DATE + 1, '10:00', 'u-trillo-admin', 1, 1, false, false, ARRAY['c-prod-trillo','c-plant-fomento','c-trans-colonia'], NOW() - INTERVAL '1 hour', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-02', 'fr-02', 'Trigo', 28, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, created_at, updated_at) VALUES
('fa-02', 'fr-02', 'c-trans-colonia', 'u-fomento-admin', 'active', 'u-colonia-ch1', 'Miguel Acosta', 'ABC 1234', 't-colonia-01', 0, 'pending', 1, 28, NOW(), NOW());

-- Flete 3: ACEPTADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, created_at, updated_at) VALUES
('fr-03', 'F26-DEM.0003', 'accepted', 'c-prod-trillo', 'Frente / Lote 1', -33.9050, -57.4850, 'f-frente', 'c-plant-agro', 'AGROTERRA Young', -32.6900, -57.6300, 'pl-agro', CURRENT_DATE, '07:00', 'u-trillo-admin', 1, 1, false, false, ARRAY['c-prod-trillo','c-plant-agro','c-trans-helve'], NOW() - INTERVAL '12 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-03', 'fr-03', 'Maiz', 30, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, created_at, updated_at) VALUES
('fa-03', 'fr-03', 'c-trans-helve', 'u-agro-admin', 'accepted', 'u-helve-ch1', 'Fabian Olivera', 'JKL 3456', 't-helve-01', 0, 'accepted', 1, 30, NOW(), NOW());

-- Flete 4: EN VIAJE
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, started_at, created_at, updated_at) VALUES
('fr-04', 'F26-DEM.0004', 'in_progress', 'c-prod-palermo', 'Campo Palermo / Norte', -34.1500, -57.8100, 'f-palermo', 'l-pal-norte', 'c-plant-fadisol', 'FADISOL Colonia', -34.4500, -57.8600, 'pl-fadisol', CURRENT_DATE, '06:00', 'u-palermo-admin', 1, 1, false, false, ARRAY['c-prod-palermo','c-plant-fadisol','c-trans-colonia'], NOW() - INTERVAL '2 hours', NOW() - INTERVAL '5 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-04', 'fr-04', 'Soja', 32, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, trip_started_at, created_at, updated_at) VALUES
('fa-04', 'fr-04', 'c-trans-colonia', 'u-fadisol-admin', 'accepted', 'u-colonia-ch2', 'Pedro Nunez', 'DEF 5678', 't-colonia-02', 0, 'in_progress', 1, 32, NOW() - INTERVAL '2 hours', NOW(), NOW());

-- Flete 5: CARGADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, started_at, loaded_at, transporter_loaded_confirmed_at, producer_loaded_confirmed_at, created_at, updated_at) VALUES
('fr-05', 'F26-DEM.0005', 'loaded', 'c-prod-trillo', 'Cerros Negros / Loma', -33.8400, -57.5500, 'f-cerros', 'l-loma', 'c-plant-agro', 'AGROTERRA Nueva Helvecia', -34.3050, -57.2350, 'pl-agro', CURRENT_DATE, '05:00', 'u-trillo-admin', 1, 1, false, false, ARRAY['c-prod-trillo','c-plant-agro','c-trans-colonia'], NOW() - INTERVAL '6 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '8 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-05', 'fr-05', 'Girasol', 25, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, loaded_tons, trip_started_at, trip_loaded_at, created_at, updated_at) VALUES
('fa-05', 'fr-05', 'c-trans-colonia', 'u-agro-admin', 'accepted', 'u-colonia-ch1', 'Miguel Acosta', 'ABC 1234', 't-colonia-01', 0, 'loaded', 1, 25, 25.5, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '3 hours', NOW(), NOW());

-- Flete 6: TERMINADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, started_at, loaded_at, finished_at, transporter_loaded_confirmed_at, producer_loaded_confirmed_at, transporter_finished_confirmed_at, plant_finished_confirmed_at, created_at, updated_at) VALUES
('fr-06', 'F26-DEM.0006', 'finished', 'c-prod-trillo', 'Frente / Lote 2', -33.9150, -57.4950, 'f-frente', 'c-plant-fomento', 'Fomento NH Juan Lacaze', -34.4300, -57.4500, 'pl-fomento', CURRENT_DATE - 1, '07:00', 'u-trillo-admin', 1, 1, false, false, ARRAY['c-prod-trillo','c-plant-fomento','c-trans-helve'], NOW() - INTERVAL '28 hours', NOW() - INTERVAL '26 hours', NOW() - INTERVAL '22 hours', NOW() - INTERVAL '26 hours', NOW() - INTERVAL '26 hours', NOW() - INTERVAL '22 hours', NOW() - INTERVAL '22 hours', NOW() - INTERVAL '30 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-06', 'fr-06', 'Trigo', 30, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, loaded_tons, trip_started_at, trip_loaded_at, trip_finished_at, created_at, updated_at) VALUES
('fa-06', 'fr-06', 'c-trans-helve', 'u-fomento-admin', 'accepted', 'u-helve-ch1', 'Fabian Olivera', 'JKL 3456', 't-helve-01', 0, 'finished', 1, 30, 29.8, NOW() - INTERVAL '28 hours', NOW() - INTERVAL '26 hours', NOW() - INTERVAL '22 hours', NOW(), NOW());

-- Flete 7: CANCELADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, cancel_reason, created_at, updated_at) VALUES
('fr-07', 'F26-DEM.0007', 'canceled', 'c-prod-palermo', 'Campo Palermo / Sur', -34.1700, -57.8300, 'f-palermo', 'c-plant-fadisol', 'FADISOL Carmelo', -34.0000, -58.2800, 'pl-fadisol', CURRENT_DATE - 2, '08:00', 'u-palermo-admin', 1, 0, false, false, ARRAY['c-prod-palermo','c-plant-fadisol'], 'Lluvia, caminos intransitables', NOW() - INTERVAL '48 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-07', 'fr-07', 'Cebada', 20, NOW());

-- Flete 8: MULTI-CAMION
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, created_at, updated_at) VALUES
('fr-08', 'F26-DEM.0008', 'assigned', 'c-prod-trillo', 'Cerros Negros / Maizales', -33.8450, -57.5350, 'f-cerros', 'l-maizales', 'c-plant-sofoval', 'SOFOVAL Valdense', -34.3100, -57.2400, 'pl-sofoval', CURRENT_DATE + 2, '06:00', 'u-trillo-admin', 3, 2, true, false, ARRAY['c-prod-trillo','c-plant-sofoval','c-trans-colonia','c-trans-helve'], NOW() - INTERVAL '30 minutes', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-08', 'fr-08', 'Soja', 90, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, created_at, updated_at) VALUES
('fa-08a', 'fr-08', 'c-trans-colonia', 'u-sofoval-admin', 'active', 'u-colonia-ch1', 'Miguel Acosta', 'ABC 1234', 't-colonia-01', 0, 'pending', 1, 30, NOW(), NOW()),
('fa-08b', 'fr-08', 'c-trans-helve', 'u-sofoval-admin', 'active', 'u-helve-ch1', 'Fabian Olivera', 'JKL 3456', 't-helve-01', 1, 'pending', 2, 30, NOW(), NOW());

-- Flete 9: FLOTA PROPIA
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, created_at, updated_at) VALUES
('fr-09', 'F26-DEM.0009', 'accepted', 'c-prod-trillo', 'Frente / Lote 1', -33.9050, -57.4850, 'f-frente', 'l-frente1', 'c-plant-sofoval', 'SOFOVAL Miguelete', -33.8900, -57.4800, 'pl-sofoval', CURRENT_DATE, '09:00', 'u-trillo-admin', 1, 1, false, true, ARRAY['c-prod-trillo','c-plant-sofoval'], NOW() - INTERVAL '4 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-09', 'fr-09', 'Sorgo', 28, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, created_at, updated_at) VALUES
('fa-09', 'fr-09', 'c-prod-trillo', 'u-trillo-admin', 'accepted', 'u-trillo-chofer', 'Carlos Perez', 'SBC 2045', 't-trillo-01', 0, 'accepted', 1, 28, NOW(), NOW());

-- Flete 10: TERMINADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, started_at, loaded_at, finished_at, transporter_loaded_confirmed_at, producer_loaded_confirmed_at, transporter_finished_confirmed_at, plant_finished_confirmed_at, created_at, updated_at) VALUES
('fr-10', 'F26-DEM.0010', 'finished', 'c-prod-palermo', 'Campo Palermo / Norte', -34.1500, -57.8100, 'f-palermo', 'c-plant-sofoval', 'SOFOVAL Valdense', -34.3100, -57.2400, 'pl-sofoval', CURRENT_DATE - 1, '06:00', 'u-palermo-admin', 1, 1, false, false, ARRAY['c-prod-palermo','c-plant-sofoval','c-trans-colonia'], NOW() - INTERVAL '30 hours', NOW() - INTERVAL '28 hours', NOW() - INTERVAL '24 hours', NOW() - INTERVAL '28 hours', NOW() - INTERVAL '28 hours', NOW() - INTERVAL '24 hours', NOW() - INTERVAL '24 hours', NOW() - INTERVAL '32 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-10', 'fr-10', 'Maiz', 32, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, loaded_tons, trip_started_at, trip_loaded_at, trip_finished_at, created_at, updated_at) VALUES
('fa-10', 'fr-10', 'c-trans-colonia', 'u-sofoval-admin', 'accepted', 'u-colonia-ch2', 'Pedro Nunez', 'DEF 5678', 't-colonia-02', 0, 'finished', 1, 32, 31.5, NOW() - INTERVAL '30 hours', NOW() - INTERVAL '28 hours', NOW() - INTERVAL '24 hours', NOW(), NOW());

-- Flete 11: PENDIENTE MULTI
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, origin_lot_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, created_at, updated_at) VALUES
('fr-11', 'F26-DEM.0011', 'pending_assignment', 'c-prod-palermo', 'Campo Palermo / Sur', -34.1700, -57.8300, 'f-palermo', 'l-pal-sur', 'c-plant-fomento', 'Fomento NH Nueva Helvecia', -34.3100, -57.2400, 'pl-fomento', CURRENT_DATE + 1, '07:00', 'u-palermo-admin', 2, 0, true, false, ARRAY['c-prod-palermo','c-plant-fomento'], NOW() - INTERVAL '45 minutes', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-11', 'fr-11', 'Soja', 55, NOW());

-- Flete 12: TERMINADO
INSERT INTO freights (id, code, status, origin_company_id, "originName", "originLat", "originLng", field_id, dest_company_id, "destName", "destLat", "destLng", dest_plant_id, load_date, load_time, requested_by_id, truck_count, assigned_truck_count, is_multi_truck, use_own_fleet, participant_company_ids, started_at, loaded_at, finished_at, transporter_loaded_confirmed_at, producer_loaded_confirmed_at, transporter_finished_confirmed_at, plant_finished_confirmed_at, created_at, updated_at) VALUES
('fr-12', 'F26-DEM.0012', 'finished', 'c-prod-trillo', 'Cerros Negros / Bajo', -33.8550, -57.5450, 'f-cerros', 'c-plant-fadisol', 'FADISOL Carmelo', -34.0000, -58.2800, 'pl-fadisol', CURRENT_DATE - 3, '06:00', 'u-trillo-admin', 1, 1, false, false, ARRAY['c-prod-trillo','c-plant-fadisol','c-trans-helve'], NOW() - INTERVAL '78 hours', NOW() - INTERVAL '75 hours', NOW() - INTERVAL '72 hours', NOW() - INTERVAL '75 hours', NOW() - INTERVAL '75 hours', NOW() - INTERVAL '72 hours', NOW() - INTERVAL '72 hours', NOW() - INTERVAL '80 hours', NOW());
INSERT INTO freight_items (id, freight_id, grain, tons, created_at) VALUES ('fi-12', 'fr-12', 'Trigo', 30, NOW());
INSERT INTO freight_assignments (id, freight_id, transport_company_id, assigned_by_id, status, driver_id, driver_name, plate, truck_id, queue_position, trip_status, trip_number, tons, loaded_tons, trip_started_at, trip_loaded_at, trip_finished_at, created_at, updated_at) VALUES
('fa-12', 'fr-12', 'c-trans-helve', 'u-fadisol-admin', 'accepted', 'u-helve-ch1', 'Fabian Olivera', 'JKL 3456', 't-helve-01', 0, 'finished', 1, 30, 30, NOW() - INTERVAL '78 hours', NOW() - INTERVAL '75 hours', NOW() - INTERVAL '72 hours', NOW(), NOW());

-- 11. UBICACIONES COMPARTIDAS
INSERT INTO shared_fields (id, field_id, shared_by_user_id, shared_with_user_id, active, created_at) VALUES
('sf-01', 'f-cerros', 'u-trillo-admin', 'u-sofoval-admin', true, NOW()),
('sf-02', 'f-cerros', 'u-trillo-admin', 'u-fomento-admin', true, NOW());

INSERT INTO shared_lots (id, lot_id, shared_by_user_id, shared_with_user_id, active, created_at) VALUES
('sl-01', 'l-maizales', 'u-trillo-admin', 'u-sofoval-admin', true, NOW());

COMMIT;
