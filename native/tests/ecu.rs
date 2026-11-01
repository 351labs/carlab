use carlab_engine_lab::config::EngineConfig;
use carlab_engine_lab::ecu::*;
use serde_json::json;
fn close(a:f64,b:f64,relative:f64){assert!((a-b).abs()<=relative*b.abs().max(1e-12),"{a} != {b}")}
fn input()->EcuInput{let mut i=EcuInput::default();i.actual_air_mass_flow_kgs=0.88*i.map_pressure_pa/(287.05*i.intake_temperature_k)*i.displacement_l*1e-3*i.rpm/120.0;i}
fn open_config()->EcuConfig{let mut c=EcuConfig::default();c.enabled=true;c.feedback.enabled=false;c.film.deposited_fraction=0.0;c.film.cold_deposition_gain=0.0;c}
fn loop_config()->EcuConfig{let mut c=open_config();c.feedback.enabled=true;c.feedback.warmup_seconds=0.0;c.feedback.min_coolant_temperature_k=250.0;c.feedback.steady_hold_seconds=0.0;c.sensor.warmup_seconds=0.0;c.sensor.base_delay_seconds=0.05;c.sensor.cycle_delay_degrees=0.0;c.sensor.transport_delay_scale_kg=0.0;c.sensor.time_constant_seconds=0.02;c}
#[test]
fn ecu_maps_validate_units_domain_provenance_and_bilinear_interpolation(){
    let mut map=EcuConfig::default().fuel_correction_map;map.rpm=vec![1000.0,3000.0];map.pressure_bar=vec![0.5,1.5];map.values=vec![vec![1.0,2.0],vec![2.0,3.0]];
    close(map.sample(2000.0,1.0).unwrap().value,2.0,1e-14);
    let outside=map.sample(500.0,2.0).unwrap();assert_eq!(outside.extrapolated_axes,vec!["rpm","pressureBar"]);close(outside.value,2.0,1e-14);
    let mut invalid=serde_json::to_value(&map).unwrap();invalid["axisUnits"]["pressure"]=json!("bar-gauge");assert!(EcuMap::from_value(&invalid,EcuMapKind::FuelCorrection).is_err());
    invalid=serde_json::to_value(&map).unwrap();invalid["rpm"]=json!([1000,1000]);assert!(EcuMap::from_value(&invalid,EcuMapKind::FuelCorrection).is_err());
    invalid=serde_json::to_value(&map).unwrap();invalid["values"]=json!([[1,2],[2]]);assert!(EcuMap::from_value(&invalid,EcuMapKind::FuelCorrection).is_err());
    invalid=serde_json::to_value(&map).unwrap();invalid.as_object_mut().unwrap().remove("provenance");assert!(EcuMap::from_value(&invalid,EcuMapKind::FuelCorrection).is_err());
    assert!(EcuConfig::from_value(&EngineConfig::default(),&json!({"lambdaTargetMap":{"kind":"lambdaTarget"}})).is_err());
}
#[test]
fn blend_converts_volume_to_mass_before_mixing_energy_and_stoichiometry(){
    let mut fuel=EcuConfig::default().fuel;
    let g=fuel_blend_properties(&fuel).unwrap();close(g.ethanol_mass_fraction,0.0,1e-14);close(g.stoich_afr,fuel.gasoline.stoich_afr,1e-14);
    fuel.ethanol_volume_fraction=1.0;let e=fuel_blend_properties(&fuel).unwrap();close(e.ethanol_mass_fraction,1.0,1e-14);close(e.lhv_jkg,fuel.ethanol.lhv_jkg,1e-14);
    fuel.ethanol_volume_fraction=0.2;let p=fuel_blend_properties(&fuel).unwrap();let density=0.2*fuel.ethanol.density_kg_m3+0.8*fuel.gasoline.density_kg_m3;let w=0.2*fuel.ethanol.density_kg_m3/density;
    close(p.density_kg_m3,density,1e-14);close(p.ethanol_mass_fraction,w,1e-14);assert!(w>0.2);close(p.stoich_afr,w*fuel.ethanol.stoich_afr+(1.0-w)*fuel.gasoline.stoich_afr,1e-14);close(p.lhv_jkg,w*fuel.ethanol.lhv_jkg+(1.0-w)*fuel.gasoline.lhv_jkg,1e-14);
}
#[test]
fn injector_delivery_uses_mass_units_dead_time_and_true_differential_pressure(){
    let c=EcuConfig::default().injector;let mut i=InjectorInput{requested_fuel_mass_flow_kgs:0.002,rpm:3000.0,battery_voltage_v:13.8,manifold_pressure_pa:80000.0,downstream_pressure_pa:None,actual_rail_pressure_pa:None,fuel_density_kg_m3:740.0,injector_cut:false};
    let a=injector_delivery(&c,&i).unwrap();close(a.injected_fuel_mass_flow_kgs,i.requested_fuel_mass_flow_kgs,1e-12);close(a.delta_pressure_pa,300000.0,1e-14);close(a.nominal_mass_flow_per_injector_kgs,300.0*1e-6/60.0*740.0,1e-14);
    let expected_effective_ms=i.requested_fuel_mass_flow_kgs/(a.nominal_mass_flow_per_injector_kgs*(3000.0/120.0)*4.0)*1000.0;close(a.pulse_width_ms,expected_effective_ms+a.dead_time_ms,1e-12);
    i.battery_voltage_v=9.0;let lower_voltage=injector_delivery(&c,&i).unwrap();assert!(lower_voltage.dead_time_ms>a.dead_time_ms);close(lower_voltage.injected_fuel_mass_flow_kgs,a.injected_fuel_mass_flow_kgs,1e-12);
    let mut fixed=c.clone();fixed.rail_mode=InjectorRailMode::FixedAbsolute;i.battery_voltage_v=13.8;i.manifold_pressure_pa=160000.0;let b=injector_delivery(&fixed,&i).unwrap();close(b.delta_pressure_pa,240000.0,1e-14);close(b.nominal_mass_flow_per_injector_kgs/a.nominal_mass_flow_per_injector_kgs,(240000.0_f64/300000.0).sqrt(),1e-12);
    i.actual_rail_pressure_pa=Some(10000.0);let dry=injector_delivery(&c,&i).unwrap();assert_eq!(dry.injected_fuel_mass_flow_kgs,0.0);assert!(dry.actuator_saturated);
}
#[test]
fn injector_duty_cap_and_multiple_squirts_report_real_delivery_shortfall(){
    let mut c=EcuConfig::default().injector;let i=InjectorInput{requested_fuel_mass_flow_kgs:0.02,rpm:6000.0,battery_voltage_v:13.8,manifold_pressure_pa:100000.0,downstream_pressure_pa:None,actual_rail_pressure_pa:None,fuel_density_kg_m3:740.0,injector_cut:false};
    let one=injector_delivery(&c,&i).unwrap();assert!(one.actuator_saturated);close(one.duty_fraction,c.max_duty_fraction,1e-14);assert!(one.injected_fuel_mass_flow_kgs<i.requested_fuel_mass_flow_kgs);
    c.squirts_per_cycle=2;let two=injector_delivery(&c,&i).unwrap();assert!(two.injected_fuel_mass_flow_kgs<one.injected_fuel_mass_flow_kgs);close(two.duty_fraction,one.duty_fraction,1e-14);
}
#[test]
fn exact_film_update_conserves_mass_and_matches_closed_form(){
    let(m,u,x,tau,dt)=(0.001,0.002,0.3,0.4,0.1);let(next,delivered)=advance_fuel_film(m,u,x,tau,dt).unwrap();let expected=m*(-dt/tau).exp()+x*u*tau*(1.0-(-dt/tau).exp());close(next,expected,1e-14);close(m+u*dt,next+delivered,1e-14);
    let mut split=m;let mut total=0.0;for _ in 0..10{let(n,d)=advance_fuel_film(split,u,x,tau,dt/10.0).unwrap();split=n;total+=d}close(split,next,1e-13);close(total,delivered,1e-13);
    let(next_cut,tail)=advance_fuel_film(next,0.0,x,tau,0.1).unwrap();assert!(tail>0.0&&next_cut<next);close(next,next_cut+tail,1e-14);
}
#[test]
fn plant_air_truth_never_enters_open_loop_fuel_feedforward(){
    let c=open_config();let mut i=input();let a=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();i.actual_air_mass_flow_kgs*=1.5;let b=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();
    close(a.requested_fuel_mass_flow_kgs,b.requested_fuel_mass_flow_kgs,1e-14);close(a.pulse_width_ms,b.pulse_width_ms,1e-14);close(b.true_lambda.unwrap()/a.true_lambda.unwrap(),1.5,1e-14);assert!(a.observed_lambda.is_none()&&!a.feedback_active&&!a.sensor_ready);
}
#[test]
fn injector_cut_leaves_film_delivery_and_blend_changes_preserve_old_fuel_identity(){
    let mut c=open_config();c.film.deposited_fraction=0.5;c.film.evaporation_time_seconds=0.4;let mut ecu=Ecu::new(c.clone());let mut i=input();for _ in 0..100{ecu.step(0.01,&i).unwrap();}let stored=ecu.get_state();assert!(stored.film_gasoline_mass_kg>0.0);assert_eq!(stored.film_ethanol_mass_kg,0.0);
    c.fuel.ethanol_volume_fraction=1.0;c.film.deposited_fraction=0.7;c.film.evaporation_time_seconds=0.8;ecu.set_config(c).unwrap();close(ecu.get_state().wall_film_mass_kg,stored.wall_film_mass_kg,1e-14);
    i.injector_cut=true;let cut=ecu.step(0.02,&i).unwrap();assert_eq!(cut.injected_fuel_mass_flow_kgs,0.0);assert!(cut.delivered_fuel_mass_flow_kgs>0.0&&cut.burnable_fuel_mass_flow_kgs>0.0);assert_eq!(cut.feed_fuel_properties.ethanol_mass_fraction,1.0);assert_eq!(cut.delivered_fuel_properties.ethanol_mass_fraction,0.0);close(cut.fuel_lhv_jkg,43e6,1e-14);assert!(cut.wall_film_mass_kg<stored.wall_film_mass_kg);assert!(cut.fuel_mass_residual_kg.abs()<1e-15);
    i.combustion_cut=true;let spark_cut=ecu.step(0.01,&i).unwrap();assert!(spark_cut.delivered_fuel_mass_flow_kgs>0.0);assert_eq!(spark_cut.burnable_fuel_mass_flow_kgs,0.0);close(spark_cut.unburned_fuel_mass_flow_kgs,spark_cut.delivered_fuel_mass_flow_kgs,1e-14);
}
#[test]
fn rich_oxygen_cap_retains_actual_fuel_energy_denominator(){
    let mut c=open_config();for r in &mut c.fuel_correction_map.values{for v in r{*v=2.0}}
    let i=input();let s=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();assert!(s.delivered_fuel_mass_flow_kgs>s.burnable_fuel_mass_flow_kgs);close(s.burnable_fuel_mass_flow_kgs,i.actual_air_mass_flow_kgs/s.stoich_afr,1e-12);assert!(s.fuel_energy_w>s.burnable_fuel_energy_w);close(s.fuel_energy_w,s.delivered_fuel_mass_flow_kgs*s.fuel_lhv_jkg,1e-14);
}
#[test]
fn delayed_sensor_does_not_see_a_future_mixture_step(){
    let mut c=open_config();c.sensor.warmup_seconds=0.0;c.sensor.base_delay_seconds=0.1;c.sensor.cycle_delay_degrees=0.0;c.sensor.transport_delay_scale_kg=0.0;c.sensor.time_constant_seconds=0.04;let mut ecu=Ecu::new(c);let mut i=input();
    for _ in 0..100{ecu.step(0.01,&i).unwrap();}close(ecu.get_state().observed_lambda.unwrap(),1.0,1e-10);
    i.actual_air_mass_flow_kgs*=2.0;let early=ecu.step(0.02,&i).unwrap();close(early.true_lambda.unwrap(),2.0,1e-12);close(early.observed_lambda.unwrap(),1.0,1e-10);
    for _ in 0..13{ecu.step(0.01,&i).unwrap();}let delayed=ecu.get_state().observed_lambda.unwrap();assert!(delayed>1.0&&delayed<2.0);
}
#[test]
fn lambda_feedback_has_the_correct_sign_and_rejects_a_declared_flow_error(){
    let mut c=loop_config();c.injector.actual_flow_scale=0.8;let i=input();let baseline=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap().true_lambda.unwrap();let mut ecu=Ecu::new(c);
    for _ in 0..500{ecu.step(0.01,&i).unwrap();}let s=ecu.get_state();assert!(s.feedback_active);assert!(s.feedback_trim>1.05);assert!((s.true_lambda.unwrap()-1.0).abs()<(baseline-1.0).abs());assert!(s.fuel_mass_residual_kg.abs()<1e-14);
}
#[test]
fn feedback_freezes_on_invalid_saturation_cut_and_domain_gates_without_windup(){
    let mut c=loop_config();c.feedback.trim_max=1.05;c.feedback.trim_min=0.95;c.feedback.kp=2.0;c.feedback.ki_per_second=3.0;c.injector.actual_flow_scale=0.5;let i=input();let mut ecu=Ecu::new(c.clone());
    for _ in 0..300{ecu.step(0.01,&i).unwrap();}assert!(ecu.get_state().feedback_trim<=1.05);
    let before=ecu.get_state().feedback_trim;let mut bad=i.clone();bad.sensor_valid=false;for _ in 0..30{ecu.step(0.01,&bad).unwrap();}close(ecu.get_state().feedback_trim,before,1e-14);assert!(!ecu.get_state().feedback_active&&!ecu.get_state().can_learn);
    c.injector.actual_flow_scale=1.0;ecu.set_config(c).unwrap();for _ in 0..500{ecu.step(0.01,&i).unwrap();}assert!(ecu.get_state().feedback_trim<1.02);
    bad=i.clone();bad.map_pressure_pa=500000.0;let outside=ecu.step(0.01,&bad).unwrap();assert!(outside.maps_extrapolated&&!outside.feedback_active&&!outside.can_learn);
    bad=i.clone();bad.injector_cut=true;assert!(!ecu.step(0.01,&bad).unwrap().feedback_active);
}
#[test]
fn stateful_ecu_is_deterministic_resettable_and_rejects_invalid_input_without_mutation(){
    let mut c=open_config();c.film.deposited_fraction=0.3;let mut a=Ecu::new(c.clone());let mut b=Ecu::new(c);let i=input();for _ in 0..100{assert_eq!(serde_json::to_value(a.step(0.01,&i).unwrap()).unwrap(),serde_json::to_value(b.step(0.01,&i).unwrap()).unwrap());}
    let before=serde_json::to_value(a.get_state()).unwrap();let mut bad=i.clone();bad.rpm=f64::NAN;assert!(a.step(0.01,&bad).is_err());assert_eq!(before,serde_json::to_value(a.get_state()).unwrap());
    a.reset();b.reset();assert_eq!(serde_json::to_value(a.get_state()).unwrap(),serde_json::to_value(b.get_state()).unwrap());assert_eq!(a.get_state().elapsed_seconds,0.0);
    let mut disabled=Ecu::new(EcuConfig::default());assert!(!disabled.step(0.1,&i).unwrap().enabled);assert_eq!(disabled.get_state().injected_mass_kg,0.0);
}

fn diesel_config()->EcuConfig{let mut c=open_config();c.combustion_mode=CombustionMode::DirectInjectionDiesel;c}
fn diesel_input()->EcuInput{let mut i=input();i.injection_downstream_pressure_pa=Some(4e6);i}
#[test]
fn diesel_mode_has_distinct_quantity_minimum_lambda_timing_and_high_pressure_configuration(){
    let si=EcuConfig::default();assert_eq!(si.combustion_mode,CombustionMode::PortInjectionSpark);
    let d=EcuConfig::from_value(&EngineConfig::default(),&json!({"enabled":true,"combustionMode":"directInjectionDiesel"})).unwrap();
    assert_eq!(d.diesel.injector.rail_mode,InjectorRailMode::FixedAbsolute);assert_eq!(d.diesel.injector.fixed_rail_pressure_pa,60e6);assert_eq!(d.diesel.injector.squirts_per_cycle,1);
    assert_eq!(d.diesel.fuel_quantity_map.kind,EcuMapKind::DieselFuelQuantity);assert_eq!(d.diesel.minimum_lambda_map.kind,EcuMapKind::DieselMinimumLambda);assert_eq!(d.diesel.injection_advance_map.kind,EcuMapKind::DieselInjectionAdvance);
    assert!(EcuConfig::from_value(&EngineConfig::default(),&json!({"combustionMode":"unrecognized"})).is_err());let mut invalid=d.clone();invalid.diesel.injector.squirts_per_cycle=2;assert!(invalid.validate().is_err());
}
#[test]
fn diesel_requires_actual_downstream_cylinder_pressure_and_uses_rail_minus_that_boundary(){
    let c=diesel_config();let mut i=diesel_input();let s=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();close(s.delta_pressure_pa,56e6,1e-14);assert_ne!(s.delta_pressure_pa,s.rail_pressure_pa-i.map_pressure_pa);
    i.injection_downstream_pressure_pa=None;assert!(evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap_err().contains("cylinder pressure"));
    i.injection_downstream_pressure_pa=Some(70e6);let dry=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();assert!(dry.actuator_saturated);assert_eq!(dry.injected_fuel_mass_flow_kgs,0.0);
}
#[test]
fn diesel_fuel_quantity_and_prescribed_phasing_are_independent_of_si_blend_and_spark_tables(){
    let mut c=diesel_config();let mut i=diesel_input();i.throttle=0.3;let a=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();
    close(a.requested_fuel_mg_per_cylinder_cycle,9.0,1e-14);close(a.injected_fuel_mass_flow_kgs,a.delivered_fuel_mass_flow_kgs,1e-14);assert_eq!(a.wall_film_mass_kg,0.0);assert!(!a.feedback_active);assert_eq!(a.feedback_trim,1.0);assert_eq!(a.spark_advance_deg,0.0);assert_eq!(a.target_lambda,0.0);
    close(a.injection_start_angle_deg.unwrap(),348.0,1e-14);close(a.start_of_combustion_deg.unwrap(),354.0,1e-14);close(a.prescribed_burn_duration_deg.unwrap(),45.0,1e-14);assert!(a.effective_injection_duration_deg.unwrap()>0.0&&a.effective_injection_duration_deg.unwrap()<=c.diesel.max_injection_duration_deg);
    c.fuel.ethanol_volume_fraction=1.0;for r in &mut c.spark_advance_map.values{for v in r{*v=40.0}}for r in &mut c.lambda_target_map.values{for v in r{*v=0.7}}let b=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();
    close(a.fuel_lhv_jkg,b.fuel_lhv_jkg,1e-14);close(a.delivered_fuel_mass_flow_kgs,b.delivered_fuel_mass_flow_kgs,1e-14);assert_eq!(a.start_of_combustion_deg,b.start_of_combustion_deg);assert_eq!(b.delivered_fuel_properties.ethanol_mass_fraction,0.0);
}
#[test]
fn diesel_uses_controller_air_estimate_for_quantity_limit_without_reading_plant_truth(){
    let c=diesel_config();let mut i=diesel_input();i.throttle=1.0;let a=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();
    assert!(a.fuel_quantity_limited);assert!(a.air_limited_fuel_mg_per_cylinder_cycle<a.requested_fuel_mg_per_cylinder_cycle);
    let desired=a.estimated_air_mass_flow_kgs/(c.diesel.fuel.stoich_afr*a.minimum_lambda.unwrap());close(a.requested_fuel_mass_flow_kgs,desired,1e-14);
    i.actual_air_mass_flow_kgs*=0.5;let b=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();close(a.requested_fuel_mass_flow_kgs,b.requested_fuel_mass_flow_kgs,1e-14);assert!(b.true_lambda.unwrap()<a.true_lambda.unwrap());assert!(b.flags.iter().any(|s|s.contains("actual-lambda-proxy-below")));
    i.requested_fuel_quantity_override_mg=Some(5.0);let direct=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();close(direct.requested_fuel_mg_per_cylinder_cycle,5.0,1e-14);assert!(!direct.fuel_quantity_limited);
}
#[test]
fn diesel_crank_window_and_combustion_cut_report_actual_delivery_and_unburned_energy(){
    let mut c=diesel_config();let mut i=diesel_input();c.diesel.max_injection_duration_deg=1.0;let short=evaluate_ecu_steady(&EngineConfig::default(),&c,&i).unwrap();assert!(short.actuator_saturated);assert!(short.injection_duration_deg.unwrap()<=1.0+1e-12);assert_eq!(short.delivered_fuel_mass_flow_kgs,0.0);
    c.diesel.max_injection_duration_deg=30.0;let mut ecu=Ecu::new(c);for _ in 0..10{ecu.step(0.01,&i).unwrap();}i.combustion_cut=true;let cut=ecu.step(0.02,&i).unwrap();assert!(cut.delivered_fuel_mass_flow_kgs>0.0);assert_eq!(cut.burnable_fuel_energy_w,0.0);close(cut.unburned_fuel_mass_flow_kgs,cut.delivered_fuel_mass_flow_kgs,1e-14);assert!(!cut.feedback_active&&!cut.can_learn);assert_eq!(cut.feedback_trim,1.0);
    i.injector_cut=true;let zero=ecu.step(0.01,&i).unwrap();assert_eq!(zero.delivered_fuel_mass_flow_kgs,0.0);assert_eq!(zero.wall_film_mass_kg,0.0);assert!(zero.fuel_mass_residual_kg.abs()<1e-14);
}
#[test]
fn switching_combustion_modes_requires_explicit_reset_when_pfi_fuel_is_stored(){
    let mut c=open_config();c.film.deposited_fraction=0.5;let mut ecu=Ecu::new(c);let i=input();for _ in 0..20{ecu.step(0.01,&i).unwrap();}let before=ecu.get_state();assert!(before.wall_film_mass_kg>0.0);
    let d=diesel_config();assert!(ecu.set_config(d.clone()).unwrap_err().contains("explicit controller reset"));close(ecu.get_state().wall_film_mass_kg,before.wall_film_mass_kg,1e-14);
    ecu.set_config_and_reset(d).unwrap();assert_eq!(ecu.get_state().wall_film_mass_kg,0.0);assert_eq!(ecu.get_state().elapsed_seconds,0.0);let state=ecu.step(0.01,&diesel_input()).unwrap();assert_eq!(state.combustion_mode,CombustionMode::DirectInjectionDiesel);assert!(state.delivered_fuel_mass_flow_kgs>0.0);
}
#[test]
fn learning_waits_for_applied_trim_and_fuel_to_settle_through_the_observation_window(){
    let mut c=loop_config();c.sensor.time_constant_seconds=0.04;c.feedback.steady_hold_seconds=0.1;let mut ecu=Ecu::new(c.clone());let mut i=input();for _ in 0..200{ecu.step(0.01,&i).unwrap();}assert!(ecu.get_state().can_learn);
    i.actual_air_mass_flow_kgs*=1.2;let mut saw_correcting=false;for _ in 0..100{let s=ecu.step(0.01,&i).unwrap();if s.feedback_trim>1.01{saw_correcting=true;assert!(!s.can_learn);assert!(s.learning_gates.iter().any(|g|g.contains("trim-target-not-settled")));}}assert!(saw_correcting);
    for _ in 0..3000{ecu.step(0.01,&i).unwrap();}assert!(ecu.get_state().can_learn);
    for row in &mut c.lambda_target_map.values{for v in row{*v=0.95}}ecu.set_config(c).unwrap();assert!(!ecu.get_state().can_learn);assert!(!ecu.step(0.01,&i).unwrap().can_learn);
}
#[test]
fn extreme_requested_fuel_is_duty_limited_instead_of_rejected_before_the_actuator(){
    let c=EcuConfig::default().injector;let i=InjectorInput{requested_fuel_mass_flow_kgs:1000.0,rpm:3000.0,battery_voltage_v:13.8,manifold_pressure_pa:100000.0,downstream_pressure_pa:None,actual_rail_pressure_pa:None,fuel_density_kg_m3:740.0,injector_cut:false};let s=injector_delivery(&c,&i).unwrap();assert!(s.actuator_saturated);assert!(s.injected_fuel_mass_flow_kgs.is_finite()&&s.injected_fuel_mass_flow_kgs<1.0);
}

#[test]
fn newly_created_and_reset_diesel_state_never_exposes_si_fuel_or_spark_defaults(){
    let mut c=diesel_config();c.fuel.ethanol_volume_fraction=1.0;c.diesel.fuel.lhv_jkg=40e6;c.diesel.fuel.stoich_afr=14.3;c.diesel.air_throttle_fraction=0.9;
    let mut ecu=Ecu::new(c.clone());
    for reset in [false,true]{
        if reset{ecu.step(0.01,&diesel_input()).unwrap();ecu.reset();}
        let s=ecu.get_state();assert_eq!(s.combustion_mode,CombustionMode::DirectInjectionDiesel);assert_eq!(s.elapsed_seconds,0.0);assert_eq!(s.feed_fuel_properties.ethanol_mass_fraction,0.0);assert_eq!(s.delivered_fuel_properties.ethanol_volume_fraction,0.0);close(s.fuel_lhv_jkg,40e6,1e-14);close(s.stoich_afr,14.3,1e-14);close(s.fuel_density_kg_m3,c.diesel.fuel.density_kg_m3,1e-14);close(s.air_throttle_fraction,0.9,1e-14);assert_eq!(s.spark_advance_deg,0.0);assert_eq!(s.target_lambda,0.0);assert!(s.injection_start_angle_deg.is_none()&&s.start_of_combustion_deg.is_none());assert!(!s.sensor_ready&&!s.feedback_active&&!s.can_learn);assert_eq!(s.wall_film_mass_kg,0.0);
    }
}

#[test]
fn every_combustion_mode_switch_requires_reset_even_with_zero_film_in_both_directions(){
    let mut si=Ecu::new(open_config());si.step(0.02,&input()).unwrap();assert_eq!(si.get_state().wall_film_mass_kg,0.0);let before_si=serde_json::to_value(si.get_state()).unwrap();
    assert!(si.set_config(diesel_config()).unwrap_err().contains("explicit controller reset"));assert_eq!(serde_json::to_value(si.get_state()).unwrap(),before_si);
    let mut di=Ecu::new(diesel_config());di.step(0.02,&diesel_input()).unwrap();assert_eq!(di.get_state().wall_film_mass_kg,0.0);let before_di=serde_json::to_value(di.get_state()).unwrap();
    assert!(di.set_config(open_config()).unwrap_err().contains("explicit controller reset"));assert_eq!(serde_json::to_value(di.get_state()).unwrap(),before_di);
    di.set_config_and_reset(open_config()).unwrap();let reset=di.get_state();assert_eq!(reset.combustion_mode,CombustionMode::PortInjectionSpark);assert_eq!(reset.elapsed_seconds,0.0);assert!(reset.observed_lambda.is_none()&&!reset.sensor_ready&&!reset.can_learn);
}
