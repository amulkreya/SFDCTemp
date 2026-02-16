
let currentPage = 1;

function loadDonors(page = 1) {
  fetch(`/donors?page=${page}`)
  .then(res => res.json())
  .then(data => {
    let rows = '';
    data.forEach(d => {
      rows += `
        <tr>
          <td>${d.donor_id}</td>
          <td>${d.first_name} ${d.last_name}</td>
          <td>${d.email}</td>
          <td>${d.mobile}</td>
          <td>${d.city}</td>
          <td>${d.state}</td>
        </tr>`;
    });
    document.getElementById('donorTable').innerHTML = rows;
  });
}

loadDonors(currentPage);
