/* SFM phone menu v1: builds one short menu and wires every hamburger to it. */
(function(){
  var MAIN=[["Services","/sfm-services.html"],["Pricing","/sfm-pricing.html"],["Results","/sfm-results.html"],["About","/sfm-about.html"],["Contact","/sfm-contact.html"]];
  var MORE=[["Our Work","/sfm-portfolio.html"],["Team","/sfm-team.html"],["Blog","/sfm-blog.html"],["AI Workshop","/sfm-ai-workshop.html"],["Podcasting","/sfm-podcasting.html"],["The Digital Garden","/sfm-digital-garden.html"],["NetWORKs Café","/sfm-networks-cafe.html"],["The Scroll","/sfm-the-scroll.html"],["Free Brand Studio","/sfm-brand-studio.html"],["Free Brand Kit","/sfm-brand-kit-free.html"],["Client login","/client-login/"]];
  var BOOK="https://link.salesfunnelmarketing.us/widget/bookings/meetingwithjayson";
  var menu,lastBtn;
  function here(h){var p=location.pathname.replace(/\.html$/,"").replace(/\/$/,"")||"/";return p===h.replace(/\.html$/,"").replace(/\/$/,"");}
  function link(l){return '<a href="'+l[1]+'"'+(here(l[1])?' aria-current="page"':'')+'>'+l[0]+'</a>';}
  function build(){
    menu=document.createElement("div");menu.id="sfmMenu";
    menu.setAttribute("role","dialog");menu.setAttribute("aria-modal","true");menu.setAttribute("aria-label","Menu");menu.setAttribute("aria-hidden","true");
    menu.innerHTML='<div class="sfm-m-top"><span class="sfm-m-title">Menu</span><button type="button" class="sfm-m-close" aria-label="Close menu">&times;</button></div>'+
      '<div class="sfm-m-body"><div class="sfm-m-main" role="navigation" aria-label="Main">'+MAIN.map(link).join("")+'</div>'+
      '<details><summary>More</summary><div class="sfm-m-more">'+MORE.map(link).join("")+'</div></details>'+
      '<a class="sfm-m-book" href="'+BOOK+'" target="_blank" rel="noopener">Book a Free Call</a></div>';
    document.body.appendChild(menu);
    menu.querySelector(".sfm-m-close").addEventListener("click",close);
    menu.addEventListener("click",function(e){if(e.target.closest("a"))close();});
  }
  function open(btn){if(!menu)build();lastBtn=btn;menu.classList.add("open");menu.setAttribute("aria-hidden","false");document.documentElement.classList.add("sfm-menu-open");
    document.querySelectorAll(".hamburger,.burger").forEach(function(b){b.setAttribute("aria-expanded","true");});
    var c=menu.querySelector(".sfm-m-close");c&&c.focus();}
  function close(){if(!menu)return;menu.classList.remove("open");menu.setAttribute("aria-hidden","true");document.documentElement.classList.remove("sfm-menu-open");
    document.body.style.overflow="";document.querySelectorAll(".hamburger,.burger").forEach(function(b){b.setAttribute("aria-expanded","false");});
    lastBtn&&lastBtn.focus&&lastBtn.focus();}
  // Catch hamburger taps before any older menu code on the page sees them.
  window.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest(".hamburger,.burger");if(!b)return;
    e.preventDefault();e.stopImmediatePropagation();menu&&menu.classList.contains("open")?close():open(b);},true);
  document.addEventListener("keydown",function(e){if(e.key==="Escape")close();});
  function addBurger(){if(document.querySelector(".hamburger,.burger"))return;var nl=document.querySelector("nav .nav-links");if(!nl)return;
    var b=document.createElement("button");b.type="button";b.className="hamburger sfm-burger-added";b.setAttribute("aria-label","Open menu");b.setAttribute("aria-expanded","false");
    b.innerHTML="<span></span><span></span><span></span>";nl.parentNode.appendChild(b);}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",addBurger);else addBurger();
})();
