import{L as M,a as S,q as d,H as B,k as g,C as y,j as f,o as _,M as w,N as $,f as T,c as L,t as A,i as N}from"./main-CJ_XRL90.js";import"./supabase-CxJ6U0-I.js";const F={async loadAdminDashboard(){const e=await this.ensureAdminRestaurants(),s=this.data.admin.metrics&&this.isCacheFresh("adminMetrics",y.adminMetrics),i=s?Promise.resolve(this.data.admin.metrics):!this.cache.adminMetricsUnavailable&&e.length>0?S.adminDashboardMetrics({restaurant_id:e[0].id||e[0].restaurant_id,period_start:A(N()),period_end:A(new Date)},{retryOnInvalidJwt:!1}).catch(o=>((o?.status===401||o?.status===403)&&(this.cache.adminMetricsUnavailable=!0),console.warn("No fue posible cargar admin_dashboard_metrics.",o),null)):Promise.resolve(null),[a,n]=await Promise.all([i,this.fetchAdminSupervisions(e,{limit:50})]);this.data.admin.metrics=a,this.data.admin.supervisions=n,s||this.touchCache("adminMetrics"),this.renderAdminMetrics(e,a),this.renderAdminSupervisions(n),this.warmAdminWorkspace()},getAdminSupervisionsRequestKey(e,s={}){const{restaurantLimit:i=e.length,from:a=_($()),to:n=_(w()),limit:o=50}=s,r=e.slice(0,i).map(t=>String(t.id||t.restaurant_id||"").trim()).filter(Boolean).join(",");return[this.currentUser?.id||this.currentUser?.email||this.currentUser?.role||"admin",a,n,String(o),r].join("|")},renderAdminMetrics(e,s){const i=document.getElementById("admin-metrics-summary");if(!i)return;const a=e.length,n=s?.shifts?.scheduled_total??s?.total_shifts??s?.shifts_total??s?.completed_shifts??0,o=s?.productivity?.scheduled_hours_total??s?.total_scheduled_hours??s?.scheduled_hours_total??s?.total_assigned_hours??s?.total_hours??s?.hours_worked??s?.worked_hours??0,r=s?.incidents_total??s?.total_incidents??0;i.innerHTML=`
            <div class="stat-card">
                <div class="stat-value">${d(String(a))}</div>
                <div class="stat-label">Restaurantes</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(String(n))}</div>
                <div class="stat-label">Turnos programados</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(L(o))}</div>
                <div class="stat-label">Horas programadas</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(String(r))}</div>
                <div class="stat-label">Novedades</div>
            </div>
        `},async fetchAdminSupervisions(e,s={}){if(this.cache.adminSupervisionsUnavailable)return[];const{restaurantLimit:i=e.length,from:a=_($()),to:n=_(w()),limit:o=50}=s,r=this.getAdminSupervisionsRequestKey(e,{restaurantLimit:i,from:a,to:n,limit:o}),t=this.cache.adminSupervisionsQuery===r,v=t?f(this.data.admin.supervisions):[];return v.length>0&&this.isCacheFresh("adminSupervisions",y.adminSupervisions)||t&&this.isCacheFresh("adminSupervisions",y.adminSupervisions)||(this.cache.adminSupervisionsRateLimitedUntil||0)>Date.now()?v:this.runPending(`adminSupervisions:${r}`,async()=>{const m=[],u=e.slice(0,i);for(let p=0;p<u.length;p+=1){const l=u[p];try{const c=await S.supervisorPresenceManage("list_by_restaurant",{restaurant_id:l.id||l.restaurant_id,from:a,to:n,limit:o},{retryOnInvalidJwt:!1});m.push(...f(c).map(b=>({...b,restaurant_name:g(b,g(l)),restaurant:b.restaurant||{id:l.id||l.restaurant_id,name:g(l)}})))}catch(c){if(c?.status===401||c?.status===403)return this.cache.adminSupervisionsUnavailable=!0,console.warn("No fue posible cargar supervisor_presence_manage para el dashboard admin.",c),[];if(c?.status===429)return this.cache.adminSupervisionsRateLimitedUntil=Date.now()+90*1e3,console.warn("Se alcanzó el rate limit de supervisor_presence_manage para el monitoreo admin.",c),v.length>0?v:m;console.warn(`No fue posible listar supervisiones para ${l?.name||l?.id}.`,c)}p<u.length-1&&await new Promise(c=>setTimeout(c,120))}const h=m.sort((p,l)=>{const c=new Date(p.created_at||p.observed_at||0).getTime();return new Date(l.created_at||l.observed_at||0).getTime()-c});return this.data.admin.supervisions=h,this.cache.adminSupervisionsQuery=r,this.cache.adminSupervisionsRateLimitedUntil=0,this.touchCache("adminSupervisions"),h})},async ensureAdminSupervisionMonitorSupervisors(e=!1){return!e&&this.data.admin.supervisionSupervisorOptions.length>0&&this.isCacheFresh("adminMonitorSupervisors",y.adminSupervisors)?this.data.admin.supervisionSupervisorOptions:this.runPending(`adminMonitorSupervisors:${e?"force":"default"}`,async()=>{let s=[];if(!e&&this.data.admin.supervisors.length>0)s=this.data.admin.supervisors.map(i=>({id:i.id,full_name:i.full_name||i.email||"Supervisora",email:i.email||""}));else{const i=await S.adminUsersManage("list",{role:"supervisora",limit:100});s=f(i).map(a=>({id:a.id||a.user_id||"",full_name:a.full_name||a.name||`${a.first_name||""} ${a.last_name||""}`.trim()||a.email||"Supervisora",email:a.email||""})).filter(a=>a.id)}return s.sort((i,a)=>String(i.full_name||"").localeCompare(String(a.full_name||""),"es",{sensitivity:"base"})),this.data.admin.supervisionSupervisorOptions=s,this.touchCache("adminMonitorSupervisors"),s})},populateAdminSupervisionMonitorSupervisorFilter(e=[],s=[]){const i=document.getElementById("admin-supervision-supervisor-filter");if(!i)return;const a=String(i.value||""),n=new Map;f(e).forEach(r=>{const t=String(r?.id||"").trim();t&&n.set(t,{id:t,label:r.full_name||r.email||"Supervisora"})}),f(s).forEach(r=>{const t=String(r?.supervisor?.id||r?.supervisor_id||"").trim();!t||n.has(t)||n.set(t,{id:t,label:r?.supervisor?.full_name||r?.supervisor_name||r?.supervisor?.email||"Supervisora"})});const o=Array.from(n.values()).sort((r,t)=>String(r.label||"").localeCompare(String(t.label||""),"es",{sensitivity:"base"}));i.innerHTML=`
            <option value="">Todas las supervisoras</option>
            ${o.map(r=>`
                <option value="${d(r.id)}">${d(r.label)}</option>
            `).join("")}
        `,a&&n.has(a)&&(i.value=a)},getFilteredAdminSupervisions(e=[]){const s=String(document.getElementById("admin-supervision-supervisor-filter")?.value||"").trim();return s?f(e).filter(i=>String(i?.supervisor?.id||i?.supervisor_id||"").trim()===s):f(e)},applyAdminSupervisionMonitorFilter(){const e=this.getFilteredAdminSupervisions(this.data.admin.supervisions),s=!!String(document.getElementById("admin-supervision-supervisor-filter")?.value||"").trim();this.renderAdminSupervisionMonitorSummary(e),this.renderAdminSupervisions(e,{containerId:"admin-supervision-monitor-list",maxItems:Number.POSITIVE_INFINITY,emptyMessage:s?"No hay supervisiones hoy para esta supervisora.":"Aún no hay supervisiones registradas hoy para monitorear."})},renderAdminSupervisions(e,s={}){const{containerId:i="admin-supervisions-list",maxItems:a=6,emptyMessage:n="Aún no hay supervisiones registradas para hoy."}=s,o=document.getElementById(i);if(!o)return;if(e.length===0){o.innerHTML=`<div class="empty-state">${d(n)}</div>`;return}const r=Number.isFinite(a)?e.slice(0,a):e;o.innerHTML=`
            <div class="admin-supervisions-stack">
                ${r.map(t=>{const v=t.supervisor?.full_name||t.supervisor_name||"Supervisora",m=t.supervisor?.email||t.supervisor_email||"",u=g(t,g(t.restaurant||null,"Restaurante sin nombre visible")),h=t.created_at||t.observed_at||"",p=Number(t.photo_count||t.evidence_count||t.photos_count||0);return`
                        <article class="admin-supervision-card">
                            <div class="admin-supervision-top">
                                <div class="admin-supervision-identity">
                                    <div class="employee-avatar admin-supervision-avatar">
                                        <i class="fas fa-user-tie"></i>
                                    </div>
                                    <div class="admin-supervision-copy">
                                        <h4>${d(v)}</h4>
                                        <p>${d(m||u)}</p>
                                    </div>
                                </div>
                                <span class="badge badge-success admin-supervision-status">Supervisión registrada</span>
                            </div>
                            <div class="admin-supervision-meta">
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Restaurante</span>
                                    <span class="admin-supervision-meta-value">${d(u)}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Hora</span>
                                    <span class="admin-supervision-meta-value">${d(T(h))}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Observación</span>
                                    <span class="admin-supervision-meta-value">${d(t.observations||t.notes||"Sin observaciones registradas")}</span>
                                </div>
                                <div class="admin-supervision-meta-item">
                                    <span class="admin-supervision-meta-label">Evidencias</span>
                                    <span class="admin-supervision-meta-value">${d(p>0?`${p} foto(s)`:"Sin conteo disponible")}</span>
                                </div>
                            </div>
                        </article>
                    `}).join("")}
            </div>
        `},renderAdminSupervisionMonitorSummary(e){const s=document.getElementById("admin-supervision-monitor-summary");if(!s)return;const i=f(e),a=i.length,n=new Set,o=new Set;let r=0;i.forEach(t=>{const v=String(t.supervisor?.id||t.supervisor_id||t.supervisor_name||"").trim(),m=String(t.restaurant?.id||t.restaurant_id||t.restaurant_name||"").trim();v&&n.add(v),m&&o.add(m),r+=Number(t.photo_count||t.evidence_count||t.photos_count||0)}),s.innerHTML=`
            <div class="stat-card">
                <div class="stat-value">${d(String(a))}</div>
                <div class="stat-label">Supervisiones</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(String(n.size))}</div>
                <div class="stat-label">Supervisoras activas</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(String(o.size))}</div>
                <div class="stat-label">Restaurantes visitados</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${d(String(r))}</div>
                <div class="stat-label">Evidencias</div>
            </div>
        `},async loadAdminSupervisionMonitor(){const e=await this.ensureAdminRestaurants(),[s,i]=await Promise.all([this.ensureAdminSupervisionMonitorSupervisors(),this.fetchAdminSupervisions(e,{restaurantLimit:e.length,from:_($()),to:_(w()),limit:50})]);this.data.admin.supervisions=i,this.populateAdminSupervisionMonitorSupervisorFilter(s,i),this.applyAdminSupervisionMonitorFilter()},populateAdminSupervisorRestaurantFilter(){const e=document.getElementById("admin-supervisor-restaurant-filter");if(!e)return;const s=e.value;e.innerHTML=`
            <option value="">Todos los restaurantes</option>
            ${this.data.admin.restaurants.map(i=>`
                <option value="${d(String(i.id||i.restaurant_id))}">
                    ${d(g(i))}
                </option>
            `).join("")}
        `,s&&(e.value=s)},resetAdminSupervisorForm(){document.getElementById("admin-supervisor-form")?.reset();const s=document.getElementById("admin-supervisor-edit-id"),i=document.getElementById("admin-supervisor-form-title"),a=document.getElementById("admin-supervisor-submit-label"),n=document.getElementById("admin-supervisor-cancel-btn"),o=document.getElementById("admin-supervisor-active");s&&(s.value=""),i&&(i.textContent="Nueva Supervisora"),a&&(a.textContent="Guardar Supervisora"),n&&n.classList.add("hidden"),o&&(o.checked=!0)},beginEditAdminSupervisor(e){const s=this.data.admin.supervisors.find(i=>String(i.id)===String(e));if(!s){this.showToast("No fue posible cargar la supervisora seleccionada.",{tone:"error",title:"No fue posible continuar"});return}document.getElementById("admin-supervisor-edit-id").value=s.id,document.getElementById("admin-supervisor-full-name").value=s.full_name||"",document.getElementById("admin-supervisor-email").value=s.email||"",document.getElementById("admin-supervisor-phone").value=s.phone_e164||"",document.getElementById("admin-supervisor-active").checked=s.is_active!==!1,document.getElementById("admin-supervisor-form-title").textContent="Editar Supervisora",document.getElementById("admin-supervisor-submit-label").textContent="Actualizar Supervisora",document.getElementById("admin-supervisor-cancel-btn").classList.remove("hidden"),window.scrollTo({top:0,behavior:"smooth"})},async submitAdminSupervisorForm(){const e=document.getElementById("admin-supervisor-edit-id")?.value?.trim(),s=document.getElementById("admin-supervisor-full-name")?.value?.trim(),i=document.getElementById("admin-supervisor-email")?.value?.trim(),a=document.getElementById("admin-supervisor-phone")?.value?.trim(),n=document.getElementById("admin-supervisor-active")?.checked??!0;if(!s||!i||!a){this.showToast("Completa nombre, correo y teléfono de la supervisora.",{tone:"warning",title:"Faltan datos"});return}if(!/^\+[1-9]\d{7,14}$/.test(a)){this.showToast("El teléfono debe estar en formato E.164, por ejemplo +573001112233.",{tone:"warning",title:"Teléfono inválido"});return}const o=!!e,r=o?{user_id:e,full_name:s,email:i,phone_number:a,is_active:n}:{role:"supervisora",full_name:s,email:i,phone_number:a,is_active:n};this.showLoading(o?"Actualizando supervisora...":"Creando supervisora...","Guardando los datos.");try{const t=await S.adminUsersManage(o?"update":"create",r);this.invalidateCache("adminSupervisors"),this.resetAdminSupervisorForm(),await this.loadAdminSupervisors(!0);const v=t?.temporary_password||t?.generated_password||t?.password||"123456";o?this.showToast("Supervisora actualizada correctamente.",{tone:"success",title:"Actualización exitosa"}):this.showToast(`Supervisora creada correctamente. Clave inicial: ${v}.`,{tone:"success",title:"Creación exitosa",duration:5200})}catch(t){this.showToast(this.getErrorMessage(t,"No fue posible guardar la supervisora."),{tone:"error",title:"No fue posible guardar la supervisora"})}finally{this.hideLoading()}},async loadAdminSupervisors(e=!1){const s=document.getElementById("admin-supervisors-list");s&&(e||this.data.admin.supervisors.length===0)&&(s.innerHTML='<div class="empty-state">Cargando supervisoras...</div>'),await this.ensureAdminRestaurants(e),this.populateAdminSupervisorRestaurantFilter();const i=document.getElementById("admin-supervisor-search")?.value?.trim(),a=document.getElementById("admin-supervisor-status-filter")?.value||"all",n=document.getElementById("admin-supervisor-restaurant-filter")?.value||"",o=JSON.stringify({search:i||"",statusFilter:a,restaurantFilter:n});if(!e&&this.data.admin.supervisors.length>0&&this.cache.adminSupervisorsQuery===o&&this.isCacheFresh("adminSupervisors",y.adminSupervisors)){const m=n?this.data.admin.supervisors.filter(u=>u.assignments.some(h=>String(h.restaurant_id)===String(n))):this.data.admin.supervisors;this.renderAdminSupervisorList(m);return}const r={role:"supervisora",limit:100};i&&(r.search=i),a==="active"?r.is_active=!0:a==="inactive"&&(r.is_active=!1);const t=await this.runPending(`adminSupervisors:${o}:${e?"force":"default"}`,async()=>{const m=await S.adminUsersManage("list",r);return Promise.all(f(m).map(async u=>{const h=u.id||u.user_id;let p=[];if(h)try{p=f(await S.adminSupervisorsManage("list_by_supervisor",{supervisor_id:h}))}catch(c){console.warn(`No fue posible cargar asignaciones para la supervisora ${h}.`,c)}const l=p.map(c=>{const b=c.restaurant_id||c.restaurant?.id,I=this.data.admin.restaurants.find(E=>String(E.id||E.restaurant_id)===String(b));return b?{restaurant_id:b,name:g(c,g(I))}:null}).filter(Boolean);return{id:h,full_name:u.full_name||u.name||`${u.first_name||""} ${u.last_name||""}`.trim()||"Supervisora",email:u.email||"-",phone_e164:u.phone_e164||u.phone_number||"-",is_active:u.is_active!==!1,assignments:l,raw:u}}))});this.data.admin.supervisors=t;const v=n?t.filter(m=>m.assignments.some(u=>String(u.restaurant_id)===String(n))):t;this.cache.adminSupervisorsQuery=o,this.touchCache("adminSupervisors"),this.renderAdminSupervisorList(v)},renderAdminSupervisorList(e){const s=document.getElementById("admin-supervisors-list");if(!s)return;if(e.length===0){s.innerHTML='<div class="empty-state">No hay supervisoras que coincidan con el filtro actual.</div>';return}const i=this.currentUser?.role==="super_admin";s.innerHTML=e.map(a=>{const n=String(a.id||""),o=a.assignments||[],r=this.data.admin.restaurants.filter(l=>!o.some(c=>String(c.restaurant_id)===String(l.id||l.restaurant_id))),t=`admin-supervisor-assign-${n}`,v=a.is_active?"Activa":"Inactiva",m=a.is_active?"badge-success":"badge-danger",u=r.length===0?"disabled":"",h=this.getPhoneBindingActionState(a),p=i&&h.visible?`
                        <button
                            type="button"
                            class="btn btn-warning btn-inline"
                            data-action="clear-phone-supervisor"
                            data-supervisor-id="${d(n)}"
                            title="Remover el teléfono actual del perfil para poder registrar otro."
                        >
                            <i class="fas fa-unlink"></i>
                            <span>Desvincular Teléfono</span>
                        </button>
                    `:"";return`
                <article class="admin-supervisor-card">
                    <div class="admin-supervisor-top">
                        <div class="admin-supervisor-identity">
                            <div class="employee-avatar admin-supervisor-avatar">${d(B(a.full_name||a.email))}</div>
                            <div class="admin-supervisor-copy">
                                <h4>${d(a.full_name||"Supervisora")}</h4>
                                <p>${d(a.email||"-")} • ${d(a.phone_e164||"-")}</p>
                                <div class="audit-meta">ID: ${d(n||"-")}</div>
                            </div>
                        </div>
                        <span class="badge ${m} admin-supervisor-status">${v}</span>
                    </div>

                    <div class="admin-supervisor-section">
                        <span class="info-item-label">Restaurantes asignados</span>
                        ${o.length>0?`
                            <div class="assignment-list">
                                ${o.map(l=>`
                                    <span class="assignment-chip">
                                        ${d(g(l))}
                                        <button
                                            type="button"
                                            title="Desasignar"
                                            data-action="admin-unassign-restaurant"
                                            data-supervisor-id="${d(n)}"
                                            data-restaurant-id="${d(String(l.restaurant_id))}"
                                        >
                                            <i class="fas fa-times"></i>
                                        </button>
                                    </span>
                                `).join("")}
                            </div>
                        `:'<p class="muted-copy">Sin restaurantes asignados todavía.</p>'}
                    </div>

                    <div class="admin-supervisor-assignment-row">
                        <div class="form-group admin-panel-field admin-supervisor-select-wrap">
                            <label>Asignar restaurante</label>
                            <select id="${d(t)}" class="dark-control" ${u}>
                                <option value="">${r.length>0?"Selecciona un restaurante":"Sin restaurantes disponibles"}</option>
                                ${r.map(l=>`
                                    <option value="${d(String(l.id||l.restaurant_id))}">
                                        ${d(g(l))}
                                    </option>
                                `).join("")}
                            </select>
                        </div>
                        <button
                            type="button"
                            class="btn btn-primary btn-inline admin-assign-btn"
                            data-action="admin-assign-restaurant"
                            data-supervisor-id="${d(n)}"
                            ${u}
                        >
                            <i class="fas fa-link"></i>
                            <span>Asignar</span>
                        </button>
                    </div>

                    <div class="admin-supervisor-actions">
                        ${p}
                        <button
                            type="button"
                            class="btn btn-secondary btn-inline"
                            data-action="admin-edit-supervisor"
                            data-supervisor-id="${d(n)}"
                        >
                            <i class="fas fa-pen"></i>
                            <span>Editar</span>
                        </button>
                        <button
                            type="button"
                            class="btn ${a.is_active?"btn-danger":"btn-success"} btn-inline"
                            data-action="admin-toggle-supervisor-status"
                            data-supervisor-id="${d(n)}"
                            data-currently-active="${a.is_active?"true":"false"}"
                        >
                            <i class="fas ${a.is_active?"fa-user-slash":"fa-user-check"}"></i>
                            <span>${a.is_active?"Desactivar":"Activar"}</span>
                        </button>
                    </div>
                </article>
            `}).join("")},async toggleAdminSupervisorStatus(e,s){this.showLoading(s?"Desactivando supervisora...":"Activando supervisora...","Actualizando el acceso.");try{await S.adminUsersManage(s?"deactivate":"activate",{user_id:e,...s?{reason:"Actualización desde el panel administrativo."}:{}}),this.invalidateCache("adminSupervisors"),await this.loadAdminSupervisors(!0),this.showToast(s?"Supervisora desactivada correctamente.":"Supervisora activada correctamente.",{tone:"success",title:"Cambio guardado"})}catch(i){this.showToast(this.getErrorMessage(i,"No fue posible actualizar el estado de la supervisora."),{tone:"error",title:"No fue posible actualizar el estado"})}finally{this.hideLoading()}},async assignRestaurantToSupervisor(e){const i=document.getElementById(`admin-supervisor-assign-${e}`)?.value;if(!i){this.showToast("Selecciona un restaurante para asignar.",{tone:"warning",title:"Falta seleccionar restaurante"});return}this.showLoading("Asignando restaurante...","Guardando el cambio.");try{await S.adminSupervisorsManage("assign",{supervisor_id:e,restaurant_id:Number.isFinite(Number(i))?Number(i):i}),this.invalidateCache("adminSupervisors"),await this.loadAdminSupervisors(!0),this.showToast("Restaurante asignado correctamente.",{tone:"success",title:"Asignación exitosa"})}catch(a){this.showToast(this.getErrorMessage(a,"No fue posible asignar el restaurante."),{tone:"error",title:"No fue posible asignar el restaurante"})}finally{this.hideLoading()}},async unassignRestaurantFromSupervisor(e,s){this.showLoading("Desasignando restaurante...","Guardando el cambio.");try{await S.adminSupervisorsManage("unassign",{supervisor_id:e,restaurant_id:Number.isFinite(Number(s))?Number(s):s}),this.invalidateCache("adminSupervisors"),await this.loadAdminSupervisors(!0),this.showToast("Restaurante desasignado correctamente.",{tone:"success",title:"Cambio guardado"})}catch(i){this.showToast(this.getErrorMessage(i,"No fue posible desasignar el restaurante."),{tone:"error",title:"No fue posible desasignar el restaurante"})}finally{this.hideLoading()}},async requestPasswordReset(){if(!this.supabase){this.setLoginError("Supabase Auth no está disponible para recuperar la contraseña.");return}const e=document.getElementById("login-email")?.value?.trim();if(!e){this.setLoginError("Escribe primero tu correo electrónico para enviar el enlace de recuperación.");return}this.setLoginError(""),this.setLoginNotice(""),this.showLoading("Enviando recuperación...","Solicitando enlace de restablecimiento de contraseña.");try{const s=await this.supabase.auth.resetPasswordForEmail(e,{redirectTo:window.location.href});if(s.error)throw s.error;this.setLoginNotice(`Si el correo ${e} existe, Supabase enviará las instrucciones de recuperación.`)}catch(s){this.setLoginError(this.getErrorMessage(s,"No fue posible solicitar la recuperación de contraseña."))}finally{this.hideLoading()}},adminAction(e){const i={supervisores:"admin-supervisors","monitoreo-supervisoras":"admin-supervision-monitor"}[e];if(!i){this.showToast("Acción administrativa en preparación.",{tone:"info",title:"Próximamente"});return}this.navigate(i)},showNotification(){const e=this.backend.connected?"Sistema listo":"Sistema en revisión",s=this.currentUser?M[this.currentUser.role]||this.currentUser.role:"Sin sesión";this.showToast(`• ${e}
• Rol actual: ${s}
• Sesión lista para operar.`,{tone:"info",title:"Notificaciones"})},updateDebugInfo(){const e=document.getElementById("debug-status"),s=document.getElementById("debug-page"),i=document.getElementById("debug-user"),a=document.getElementById("debug-backend");e&&(e.textContent=this.backend.connected?"OK":"APP"),s&&(s.textContent=this.currentPage),i&&(i.textContent=this.currentUser?.email||"none"),a&&(a.textContent=this.backend.statusText)}};export{F as adminMethods};
