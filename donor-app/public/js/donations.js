function searchDonor() {
  let mobile = document.getElementById("mobileSearch").value;

  fetch(`/donors/search?mobile=${mobile}`)
  .then(res => res.json())
  .then(data => {
    if(data.length > 0){
      let d = data[0];
      document.getElementById("donorInfo").innerHTML =
        `<div class="alert alert-success">
          ${d.first_name} ${d.last_name} <br>
          Email: ${d.email} <br>
          Donor ID: ${d.donor_id}
        </div>`;
    } else {
      alert("No donor found");
    }
  });
}

