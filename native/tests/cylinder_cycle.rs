use carlab_engine_lab::cylinder_cycle::{
    compressible_orifice_flow, cylinder_volume, solve_cylinder_cycle,
    valve_effective_area, CylinderCycleConfig,
};
use serde_json::json;
use std::f64::consts::PI;

fn relative(a:f64,b:f64)->f64{(a-b).abs()/b.abs().max(1e-12)}
fn configured(v:serde_json::Value)->CylinderCycleConfig{CylinderCycleConfig::from_value(&v).unwrap()}

#[test]
fn slider_crank_preserves_swept_volume_compression_and_closure(){
    let c=CylinderCycleConfig::default();
    let tdc=cylinder_volume(&c,0.0);let bdc=cylinder_volume(&c,180.0);
    let swept=PI*c.bore_m.powi(2)/4.0*c.stroke_m;
    assert!(relative(bdc-tdc,swept)<1e-12);
    assert!(relative(bdc/tdc,c.compression_ratio)<1e-12);
    assert_eq!(cylinder_volume(&c,360.0),tdc);assert_eq!(cylinder_volume(&c,720.0),tdc);
    assert!(relative(cylinder_volume(&c,90.0),cylinder_volume(&c,630.0))<1e-12);
}

#[test]
fn compressible_flow_reverses_at_upstream_temperature_and_chokes_continuously(){
    let flow=|pa,ta,pb,tb,area|compressible_orifice_flow(pa,ta,pb,tb,area,0.7,1.33,287.05).unwrap();
    assert_eq!(flow(1e5,300.0,1e5,600.0,0.0001),0.0);
    let forward=flow(2e5,350.0,1e5,500.0,0.0001);
    assert!(forward>0.0);assert_eq!(flow(1e5,500.0,2e5,350.0,0.0001),-forward);
    let deep=flow(2e5,350.0,10000.0,500.0,0.0001);
    assert_eq!(deep,flow(2e5,350.0,20000.0,500.0,0.0001));
    let gamma=1.33_f64;let critical=(2.0/(gamma+1.0)).powf(gamma/(gamma-1.0));
    assert!(relative(deep,flow(2e5,350.0,2e5*critical*(1.0+1e-6),500.0,0.0001))<1e-8);
    assert_eq!(flow(2e5,350.0,1e5,300.0,0.0),0.0);
    assert!(compressible_orifice_flow(-1.0,300.0,1e5,300.0,0.0001,0.7,1.33,287.05).is_err());
}

#[test]
fn valve_curtain_wraps_and_respects_its_seat_area(){
    assert_eq!(valve_effective_area(710.0,710.0,220.0,0.032,0.009,2.0),0.0);
    assert_eq!(valve_effective_area(220.0,710.0,220.0,0.032,0.009,2.0),0.0);
    assert_eq!(valve_effective_area(400.0,710.0,220.0,0.032,0.009,2.0),0.0);
    assert!(valve_effective_area(0.0,710.0,220.0,0.032,0.009,2.0)>0.0);
    assert!(valve_effective_area(100.0,710.0,220.0,0.032,0.009,2.0)<=2.0*PI*0.032_f64.powi(2)/4.0);
}

#[test]
fn sealed_motoring_matches_the_adiabatic_invariant(){
    let c=configured(json!({"intakeValveLiftM":0,"exhaustValveLiftM":0,"fuelMassKg":0,"heatTransferWm2K":0,"initialPressurePa":1e5,"initialTemperatureK":315,"settlingCycles":0,"stepDeg":1}));
    let r=solve_cylinder_cycle(&c).unwrap();
    let invariant=r.trace.pressure_pa[0]*r.trace.volume_m3[0].powf(c.gamma);
    for i in 0..r.trace.angle_deg.len(){
        assert!(relative(r.trace.pressure_pa[i]*r.trace.volume_m3[i].powf(c.gamma),invariant)<0.0001);
        assert_eq!(r.trace.mass_kg[i],r.initial_mass_kg);
    }
    assert_eq!(r.released_heat_j,0.0);assert_eq!(r.wall_heat_loss_j,0.0);
    assert!(r.net_work_j.abs()<0.01);assert!(r.energy_balance_residual_j.abs()<1e-10);
}

#[test]
fn full_cycle_preserves_open_system_budgets_and_pvt(){
    let r=solve_cylinder_cycle(&CylinderCycleConfig::default()).unwrap();
    assert_eq!(r.trace.angle_deg[0],0.0);assert_eq!(*r.trace.angle_deg.last().unwrap(),720.0);
    assert_eq!(r.trace.angle_deg.len(),361);
    assert!(r.fresh_charge_mass_kg>0.0&&r.fuel_mass_kg>0.0&&r.exhaust_mass_kg>0.0);
    assert!(r.net_work_j>0.0&&r.peak_pressure_pa>5e5&&r.peak_temperature_k>800.0);
    assert!(relative(r.released_heat_j,r.fuel_energy_j*r.config.combustion_efficiency)<1e-10);
    assert!(r.mass_balance_residual_kg.abs()<1e-12);assert!(r.energy_balance_residual_j.abs()<1e-8);
    assert!(relative(r.gross_work_j+r.pumping_work_j,r.net_work_j)<1e-12);
    let swept=PI*r.config.bore_m.powi(2)/4.0*r.config.stroke_m;
    assert!(relative(r.imep_pa,r.net_work_j/swept)<1e-12);
    assert!(r.residual_fraction_at_ivc>=0.0&&r.residual_fraction_at_ivc<1.0);
    assert!(r.periodic_mass_relative_error<0.02&&r.periodic_energy_relative_error<0.02);
    for i in 0..r.trace.angle_deg.len(){
        assert!(relative(r.trace.pressure_pa[i]*r.trace.volume_m3[i],r.trace.mass_kg[i]*287.05*r.trace.temperature_k[i])<1e-12);
    }
}

#[test]
fn wall_heat_removes_work_and_temperature_at_equal_fuel_input(){
    let a=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0.000025,"wallTemperatureK":400,"heatTransferWm2K":0}))).unwrap();
    let b=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0.000025,"wallTemperatureK":400,"heatTransferWm2K":350}))).unwrap();
    assert!(b.wall_heat_loss_j>0.0);assert_eq!(a.wall_heat_loss_j,0.0);
    assert!(b.peak_temperature_k<a.peak_temperature_k);assert!(b.net_work_j<a.net_work_j);
    assert!(relative(b.released_heat_j,a.released_heat_j)<1e-12);
}

#[test]
fn finite_burn_phasing_changes_work_and_pressure_with_ordered_quantiles(){
    let early=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0.00003,"sparkAdvanceDeg":18}))).unwrap();
    let late=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0.00003,"sparkAdvanceDeg":-15}))).unwrap();
    assert!(early.ca10_deg<early.ca50_deg&&early.ca50_deg<early.ca90_deg);
    assert!(early.ca10_deg>=342.0&&early.ca90_deg<=392.0);
    assert!(late.ca50_deg>early.ca50_deg+30.0);
    assert!(late.net_work_j<early.net_work_j&&late.peak_pressure_pa<early.peak_pressure_pa);
    assert!(late.peak_pressure_angle_deg>early.peak_pressure_angle_deg);
}

#[test]
fn numerical_refinement_and_variable_properties_retain_energy_accounting(){
    let coarse=solve_cylinder_cycle(&configured(json!({"stepDeg":2}))).unwrap();
    let fine=solve_cylinder_cycle(&configured(json!({"stepDeg":0.25}))).unwrap();
    assert!(relative(coarse.net_work_j,fine.net_work_j)<0.01);
    assert!(relative(coarse.peak_pressure_pa,fine.peak_pressure_pa)<0.01);
    let variable=solve_cylinder_cycle(&configured(json!({"variableHeatCapacity":true}))).unwrap();
    assert!(variable.trace.temperature_k.iter().all(|t|t.is_finite()));
    assert!(variable.energy_balance_residual_j.abs()<1e-8);
    assert!(variable.warnings.iter().any(|s|s.contains("linear air approximation")));
}

#[test]
fn independent_trace_quadrature_recovers_work_enthalpy_and_mass(){
    let r=solve_cylinder_cycle(&configured(json!({"stepDeg":0.5}))).unwrap();
    let c=&r.config;let tr=&r.trace;let cv=287.05/(c.gamma-1.0);let cp=cv+287.05;
    let (mut work,mut wall,mut incoming,mut outgoing,mut mass_change)=(0.0,0.0,0.0,0.0,0.0);
    for i in 1..tr.angle_deg.len(){
        let d_angle=tr.angle_deg[i]-tr.angle_deg[i-1];let dt=d_angle/(6.0*c.rpm);
        let p=(tr.pressure_pa[i]+tr.pressure_pa[i-1])/2.0;
        let t=(tr.temperature_k[i]+tr.temperature_k[i-1])/2.0;
        let volume=(tr.volume_m3[i]+tr.volume_m3[i-1])/2.0;
        let area=2.0*PI*c.bore_m.powi(2)/4.0+PI*c.bore_m*volume/(PI*c.bore_m.powi(2)/4.0);
        work+=p*(tr.volume_m3[i]-tr.volume_m3[i-1]);
        wall+=c.heat_transfer_wm2_k*area*(t-c.wall_temperature_k)*dt;
        let fi=(tr.intake_flow_kgs[i]+tr.intake_flow_kgs[i-1])/2.0;
        let fe=(tr.exhaust_flow_kgs[i]+tr.exhaust_flow_kgs[i-1])/2.0;
        incoming+=((if fi>0.0{fi*cp*c.intake_temperature_k}else{0.0})+(if fe<0.0{-fe*cp*c.exhaust_temperature_k}else{0.0}))*dt;
        outgoing+=((if fi<0.0{-fi*cp*t}else{0.0})+(if fe>0.0{fe*cp*t}else{0.0}))*dt;
        mass_change+=(fi-fe)*dt;
    }
    assert!(relative(work,r.net_work_j)<0.002);
    let last=tr.angle_deg.len()-1;
    let delta_u=cv*(tr.mass_kg[last]*tr.temperature_k[last]-tr.mass_kg[0]*tr.temperature_k[0]);
    assert!((delta_u-(r.released_heat_j-wall-work+incoming-outgoing)).abs()<0.003*(r.released_heat_j+incoming));
    assert!((tr.mass_kg[last]-tr.mass_kg[0]-mass_change).abs()<r.air_mass_kg*0.002);
}

#[test]
fn fuel_cut_is_heat_free_and_exhaust_restriction_increases_pumping_loss(){
    let normal=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0,"exhaustPressurePa":106000}))).unwrap();
    let restricted=solve_cylinder_cycle(&configured(json!({"fuelMassKg":0,"exhaustPressurePa":180000}))).unwrap();
    assert_eq!(normal.released_heat_j,0.0);assert_eq!(restricted.released_heat_j,0.0);
    assert!(normal.net_work_j<0.0);assert!(restricted.pumping_work_j<normal.pumping_work_j);
    assert!(restricted.mass_balance_residual_kg.abs()<1e-12&&restricted.energy_balance_residual_j.abs()<1e-8);
}

#[test]
fn partial_json_normalization_uses_dependent_defaults_and_rounds_discrete_inputs(){
    let c=configured(json!({"compressionRatio":99,"rodLengthM":0,"dischargeCoefficient":-1,"stepDeg":0,"intakeValveCount":2.6,"settlingCycles":2.6}));
    assert_eq!(c.compression_ratio,18.0);assert_eq!(c.discharge_coefficient,0.0);
    assert!(c.rod_length_m>c.stroke_m/2.0);assert!(c.step_deg>=0.125);
    assert_eq!(c.intake_valve_count,3.0);assert_eq!(c.settling_cycles,3.0);
    let partial:CylinderCycleConfig=serde_json::from_value(json!({"strokeM":0.1,"exhaustPressurePa":150000,"exhaustTemperatureK":900})).unwrap();
    assert_eq!(partial.rod_length_m,0.1*1.7);assert_eq!(partial.initial_pressure_pa,150000.0);assert_eq!(partial.initial_temperature_k,900.0);
    let normalized=CylinderCycleConfig{bore_m:f64::NAN,rpm:f64::INFINITY,..CylinderCycleConfig::default()}.normalize().unwrap();
    assert_eq!(normalized.bore_m,0.086);assert_eq!(normalized.rpm,3000.0);
}

#[test]
fn deterministic_results_and_unsettled_warning_keep_the_model_boundary_explicit(){
    let c=configured(json!({"stepDeg":4}));
    let a=solve_cylinder_cycle(&c).unwrap();let b=solve_cylinder_cycle(&c).unwrap();
    assert_eq!(serde_json::to_value(a).unwrap(),serde_json::to_value(b).unwrap());
    let unsettled=solve_cylinder_cycle(&configured(json!({"settlingCycles":0,"initialPressurePa":500000}))).unwrap();
    assert!(unsettled.warnings.iter().any(|s|s.contains("not settled")));
}
